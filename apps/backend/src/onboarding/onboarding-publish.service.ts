import { HttpStatus, Injectable } from '@nestjs/common';
import { ChairStatus, StaffMemberStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  OnboardingErrorCode,
  salonPhotoUrlSchema,
  type AdminOnboardingApplicationDto,
  type AuthenticatedUser,
  type OnboardingPublishReadinessDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { PrivateObjectStorageService } from '../storage/private-object-storage.service';
import { SalonActivationService } from '../salon-setup/salon-activation.service';
import { AdminOnboardingService } from './admin-onboarding.service';
import { onboardingNotFound, writeStatusHistory } from './onboarding.service';
import { OnboardingNotifierService } from './onboarding-notifier.service';

const PUBLISHABLE = [
  'APPROVED',
  'OWNER_INVITED',
  'AWAITING_OWNER_ACTIVATION',
  'READY_TO_PUBLISH',
] as const;
const PROMOTABLE_CATEGORIES = [
  'EXTERIOR',
  'INTERIOR',
  'STATIONS',
  'RECEPTION',
  'LOGO',
  'OTHER',
] as const;

/**
 * Publication is the last, separate gate: approval alone never makes a salon public. An admin
 * publishes only when every eligibility check passes; the existing activation rules (services,
 * chairs, barbers, three photos) then run again inside SalonActivationService, so customers can
 * book only once the shop can actually serve them.
 */
@Injectable()
export class OnboardingPublishService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminOnboardingService,
    private readonly activation: SalonActivationService,
    private readonly notifier: OnboardingNotifierService,
    private readonly publicStorage: ObjectStorageService,
    private readonly privateStorage: PrivateObjectStorageService,
  ) {}

  async readiness(id: string): Promise<OnboardingPublishReadinessDto> {
    const app = await this.prisma.salonOnboardingApplication.findUnique({
      where: { id },
      select: { status: true, salonId: true },
    });
    if (!app) throw onboardingNotFound();
    const checks: OnboardingPublishReadinessDto['checks'] = [];
    const approved = ([...PUBLISHABLE, 'ACTIVE'] as readonly string[]).includes(
      app.status,
    );
    checks.push({
      key: 'approved',
      label: 'Approved by a FastQue admin',
      ok: approved,
    });
    const salon = app.salonId
      ? await this.prisma.salon.findUnique({
          where: { id: app.salonId },
          select: {
            name: true,
            addressLine: true,
            postalCode: true,
            salonType: true,
            owner: {
              select: {
                passwordHash: true,
                emailVerifiedAt: true,
                phoneVerifiedAt: true,
                status: true,
              },
            },
          },
        })
      : null;
    checks.push({ key: 'salon', label: 'Salon record exists', ok: !!salon });
    if (!salon || !app.salonId) return { ready: false, checks };
    const salonId = app.salonId;
    const [services, openDays, chairs, staff, photos] = await Promise.all([
      this.prisma.service.count({ where: { salonId, isActive: true } }),
      this.prisma.operatingHours.count({ where: { salonId, isClosed: false } }),
      this.prisma.chair.count({
        where: { salonId, status: ChairStatus.ACTIVE },
      }),
      this.prisma.salonStaff.count({
        where: { salonId, status: StaffMemberStatus.ACTIVE },
      }),
      this.prisma.photo.findMany({ where: { salonId }, select: { url: true } }),
    ]);
    const owner = salon.owner;
    checks.push(
      {
        key: 'address',
        label: 'Valid address with PIN code',
        ok: !!salon.addressLine.trim() && !!salon.postalCode,
      },
      {
        key: 'owner',
        label: 'Owner account activated and verified',
        ok:
          owner.status === 'ACTIVE' &&
          !!owner.passwordHash &&
          !!(owner.emailVerifiedAt || owner.phoneVerifiedAt),
        detail: owner.passwordHash
          ? undefined
          : 'The owner has not accepted the invitation yet.',
      },
      {
        key: 'profile',
        label: 'Salon name and type',
        ok: !!salon.name.trim() && !!salon.salonType,
      },
      {
        key: 'services',
        label: 'Confirmed service menu',
        ok: services > 0,
        detail: `${services} active services`,
      },
      {
        key: 'hours',
        label: 'Opening hours',
        ok: openDays > 0,
        detail: `${openDays} open days`,
      },
      {
        key: 'capacity',
        label: 'At least one active chair and one barber',
        ok: chairs > 0 && staff > 0,
        detail: `${chairs} chairs, ${staff} barbers (the owner adds barbers in their dashboard)`,
      },
      {
        key: 'photos',
        label: 'Three public shop photos',
        // Same rule SalonActivationService enforces on first opening: distinct valid https URLs.
        ok: validPhotoCount(photos) >= 3,
        detail: `${validPhotoCount(photos)} valid public photos`,
      },
    );
    return { ready: checks.every((c) => c.ok), checks };
  }

  /** Records the authorized publication decision, then opens the salon through the existing
   * admin activation path (which re-runs its own readiness and photo checks). */
  async publish(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AdminOnboardingApplicationDto> {
    const readiness = await this.readiness(id);
    if (!readiness.ready) {
      throw new AppException(
        OnboardingErrorCode.NOT_READY_TO_PUBLISH,
        'This salon is not ready to publish yet.',
        HttpStatus.CONFLICT,
        { checks: readiness.checks },
      );
    }
    const app = await this.prisma.$transaction(async (tx) => {
      const current = await this.admin.lockForDecision(tx, user, id);
      if (!PUBLISHABLE.includes(current.status as never) || !current.salonId) {
        throw new AppException(
          OnboardingErrorCode.INVALID_TRANSITION,
          'Only an approved salon can be published.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: {
          publishAuthorizedAt: new Date(),
          publishAuthorizedById: user.id,
        },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: 'Publication authorized',
          applicationVersion: current.version,
        },
      });
      return current;
    });
    // SalonActivationService syncs the application to ACTIVE in the same transaction that opens
    // the salon (see its onboarding hooks).
    await this.activation.updateStatusAsAdmin(user.id, app.salonId as string, {
      status: 'ACTIVE',
    });
    const owner = await this.prisma.salon.findUnique({
      where: { id: app.salonId as string },
      select: { ownerUserId: true },
    });
    await this.notifier.toEmployee(
      app.assignedEmployeeId,
      'onboarding.published',
      id,
      {
        reference: app.reference,
        salonName: app.salonName,
      },
    );
    if (owner) {
      await this.notifier.toUser(owner.ownerUserId, 'onboarding.published', {
        salonName: app.salonName,
      });
    }
    return this.admin.get(user, id);
  }

  async suspend(
    user: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<AdminOnboardingApplicationDto> {
    const app = await this.prisma.$transaction(async (tx) => {
      const current = await this.admin.lockForDecision(tx, user, id);
      if (current.status !== 'ACTIVE' || !current.salonId) {
        throw new AppException(
          OnboardingErrorCode.INVALID_TRANSITION,
          'Only a live salon can be suspended.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: `Suspended: ${reason}`,
          applicationVersion: current.version,
        },
      });
      return current;
    });
    await this.activation.updateStatusAsAdmin(user.id, app.salonId as string, {
      status: 'SUSPENDED',
    });
    return this.admin.get(user, id);
  }

  /**
   * Copies chosen private onboarding photos (never menu cards) into public salon photos. This is
   * the explicit "approved for public display" step; it requires public photo storage.
   */
  async promotePhotos(
    user: AuthenticatedUser,
    id: string,
    mediaIds: string[],
  ): Promise<AdminOnboardingApplicationDto> {
    const app = await this.prisma.$transaction((tx) =>
      this.admin.lockForDecision(tx, user, id),
    );
    if (!app.salonId) {
      throw new AppException(
        OnboardingErrorCode.INVALID_TRANSITION,
        'Photos can be made public only after approval.',
        HttpStatus.CONFLICT,
      );
    }
    const media = await this.prisma.salonOnboardingMedia.findMany({
      where: {
        id: { in: mediaIds.slice(0, 10) },
        applicationId: id,
        deletedAt: null,
        category: { in: [...PROMOTABLE_CATEGORIES] },
      },
    });
    const existing = await this.prisma.photo.count({
      where: { salonId: app.salonId },
    });
    let order = existing;
    for (const m of media) {
      const body = await this.privateStorage.get(m.storageKey);
      if (!body) continue;
      const url = await this.publicStorage.putPublicObject(
        `salons/${app.salonId}/photos/${randomUUID()}.jpg`,
        body,
        m.mimeType,
      );
      await this.prisma.photo.create({
        data: {
          salonId: app.salonId,
          url,
          type: order === 0 ? 'COVER' : 'GALLERY',
          altText: `${app.salonName} ${m.category.toLowerCase()}`,
          sortOrder: order++,
        },
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: `${media.length} photo(s) approved for public display`,
          details: { mediaIds: media.map((m) => m.id) },
          applicationVersion: app.version,
        },
      });
      await writeStatusHistory(
        tx,
        id,
        app.status,
        app.status,
        user.id,
        `${media.length} photo(s) made public`,
      );
    });
    return this.admin.get(user, id);
  }
}

function validPhotoCount(photos: Array<{ url: string }>): number {
  const unique = new Set<string>();
  for (const { url } of photos) {
    if (!salonPhotoUrlSchema.safeParse(url).success) continue;
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    unique.add(u.toString());
  }
  return unique.size;
}
