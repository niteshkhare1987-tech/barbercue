import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BookingErrorCode,
  ChairStatus,
  OnboardingErrorCode,
  SalonSetupErrorCode,
  SalonStatus,
  StaffMemberStatus,
  salonPhotoUrlSchema,
  type SalonPhotoActivationReadinessDto,
  type SalonSetupReadinessDto,
  type SalonStatusResultDto,
  type UpdateSalonStatusInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';

/**
 * Owner self-activation — the fix for the Phase 11 blocker.
 *
 * SalonsService.registerSalon creates every self-serve salon as PENDING (ARCHITECTURE.md §17
 * called this "a moderation-friendly default nobody wired up"). Nothing could move it out of
 * that state, which made a registered salon permanently unusable: AvailabilityService
 * .getSalonOrThrow requires ACTIVE, discovery/search filters on ACTIVE, and the Phase 9 QR page
 * reports "queue unavailable" for anything else. So a real owner could register a shop and then
 * hit a dead end.
 *
 * The approved product decision is owner self-activation: the owner flips their own shop open
 * when setup is done. PENDING remains reserved as a platform-owned moderation state — the schema
 * validation only permits ACTIVE and SUSPENDED here, so an owner can open or pause their shop
 * but can never put it back into (or out of) moderation themselves.
 */
@Injectable()
export class SalonActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
  ) {}

  async updateStatus(
    userId: string,
    salonId: string,
    input: UpdateSalonStatusInput,
  ): Promise<SalonStatusResultDto> {
    await this.salonAccess.assertOwnerAccess(userId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
    });
    if (!salon) {
      throw new AppException(
        BookingErrorCode.SALON_NOT_FOUND,
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Readiness is checked ONLY on the first opening (PENDING -> ACTIVE). Deliberately not on
    // SUSPENDED -> ACTIVE: a shop that has traded before is reopening after a pause, and blocking
    // that because a chair is temporarily under repair would lock an owner out of their own
    // business. Equally, nothing here ever demotes a salon — an already-ACTIVE shop whose last
    // barber goes inactive stays ACTIVE, and the queue engine's own capacity rule
    // (min(active staff, active chairs)) is what stops customers being seated meanwhile.
    if (
      input.status === SalonStatus.ACTIVE &&
      salon.status === SalonStatus.PENDING
    ) {
      return this.activatePendingSalon(salonId, userId);
    }

    // Owner "Close my shop" is a temporary same-day pause, not a moderation suspension.
    // Keep the real lifecycle status ACTIVE so the shop remains discoverable; customer booking
    // and queue entry read isClosedForToday and are blocked until the owner reopens it.
    const closingForToday = input.status === SalonStatus.SUSPENDED;
    const updated = await this.prisma.salon.update({
      where: { id: salonId },
      data: closingForToday
        ? { isClosedForToday: true }
        : {
            status:
              salon.status === SalonStatus.PENDING ||
              salon.status === SalonStatus.SUSPENDED
                ? SalonStatus.ACTIVE
                : salon.status,
            isClosedForToday: false,
            ...(salon.status === SalonStatus.SUSPENDED
              ? { shopPhotoRequirementGrandfathered: true }
              : {}),
          },
    });
    return {
      id: updated.id,
      status: updated.status,
      isClosedForToday: updated.isClosedForToday,
    };
  }

  /** Platform-admin lifecycle control. The admin actor is never treated as the shop owner. */
  async updateStatusAsAdmin(
    adminUserId: string,
    salonId: string,
    input: UpdateSalonStatusInput,
  ): Promise<SalonStatusResultDto> {
    await this.salonAccess.assertPlatformAdminAccess(adminUserId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: {
        id: true,
        status: true,
        shopPhotoRequirementGrandfathered: true,
      },
    });
    if (!salon) {
      throw new AppException(
        BookingErrorCode.SALON_NOT_FOUND,
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }

    const allowed =
      (salon.status === SalonStatus.PENDING &&
        input.status === SalonStatus.ACTIVE) ||
      (salon.status === SalonStatus.ACTIVE &&
        input.status === SalonStatus.SUSPENDED) ||
      (salon.status === SalonStatus.SUSPENDED &&
        input.status === SalonStatus.ACTIVE);
    if (!allowed) {
      throw new AppException(
        'SALON_STATUS_TRANSITION_INVALID',
        `Cannot change shop status from ${salon.status} to ${input.status}.`,
        HttpStatus.CONFLICT,
      );
    }

    const action =
      salon.status === SalonStatus.PENDING
        ? 'ADMIN_SALON_OPENED'
        : salon.status === SalonStatus.SUSPENDED
          ? 'ADMIN_SALON_REOPENED'
          : 'ADMIN_SALON_SUSPENDED';
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.salon.findUnique({
            where: { id: salonId },
            select: {
              id: true,
              status: true,
              shopPhotoRequirementGrandfathered: true,
            },
          });
          if (!current || current.status !== salon.status) {
            throw new AppException(
              'SALON_STATUS_TRANSITION_CONFLICT',
              'Shop status changed while this operation was in progress. Refresh and try again.',
              HttpStatus.CONFLICT,
            );
          }
          if (
            current.status === SalonStatus.PENDING &&
            input.status === SalonStatus.ACTIVE
          ) {
            await this.assertOnboardingPublishAuthorized(salonId, tx);
            await this.assertReadyToOpen(salonId, tx);
            await this.assertPhotoReadyToActivate(
              salonId,
              current.shopPhotoRequirementGrandfathered,
              tx,
            );
          }
          await this.syncOnboardingApplication(
            tx,
            salonId,
            input.status,
            adminUserId,
          );
          const updated = await tx.salon.update({
            where: { id: salonId },
            data: {
              status: input.status,
              isClosedForToday: false,
              ...(input.status === SalonStatus.ACTIVE ||
              current.status === SalonStatus.ACTIVE
                ? { shopPhotoRequirementGrandfathered: true }
                : {}),
            },
          });
          await tx.auditLog.create({
            data: {
              actorUserId: adminUserId,
              action,
              entityType: 'Salon',
              entityId: salonId,
              metadata: {
                previousStatus: salon.status,
                newStatus: input.status,
              },
            },
          });
          return { id: updated.id, status: updated.status };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      this.rethrowPhotoActivationConflict(error);
    }
  }

  async getPhotoReadiness(
    userId: string,
    salonId: string,
  ): Promise<SalonPhotoActivationReadinessDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { status: true, shopPhotoRequirementGrandfathered: true },
    });
    if (!salon) {
      throw new AppException(
        BookingErrorCode.SALON_NOT_FOUND,
        'Salon not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const grandfathered = this.isGrandfathered(
      salon.status,
      salon.shopPhotoRequirementGrandfathered,
    );
    const photos = await this.prisma.photo.findMany({
      where: { salonId },
      select: { url: true },
    });
    return this.toPhotoReadiness(photos, grandfathered);
  }

  private async activatePendingSalon(
    salonId: string,
    ownerUserId: string,
  ): Promise<SalonStatusResultDto> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.salon.findUnique({
            where: { id: salonId },
            select: {
              id: true,
              ownerUserId: true,
              status: true,
              shopPhotoRequirementGrandfathered: true,
            },
          });
          if (!current) {
            throw new AppException(
              BookingErrorCode.SALON_NOT_FOUND,
              'Salon not found.',
              HttpStatus.NOT_FOUND,
            );
          }
          if (current.ownerUserId !== ownerUserId) {
            throw new AppException(
              'SALON_ACCESS_DENIED',
              'You do not have access to this shop.',
              HttpStatus.FORBIDDEN,
            );
          }
          if (current.status !== SalonStatus.PENDING) {
            throw new AppException(
              'SALON_STATUS_TRANSITION_CONFLICT',
              'Shop status changed. Refresh and try again.',
              HttpStatus.CONFLICT,
            );
          }
          await this.assertOnboardingPublishAuthorized(salonId, tx);
          await this.assertReadyToOpen(salonId, tx);
          await this.assertPhotoReadyToActivate(
            salonId,
            current.shopPhotoRequirementGrandfathered,
            tx,
          );
          await this.syncOnboardingApplication(
            tx,
            salonId,
            SalonStatus.ACTIVE,
            ownerUserId,
          );
          const updated = await tx.salon.update({
            where: { id: salonId },
            data: {
              status: SalonStatus.ACTIVE,
              isClosedForToday: false,
              shopPhotoRequirementGrandfathered: true,
            },
          });
          return {
            id: updated.id,
            status: updated.status,
            isClosedForToday: updated.isClosedForToday,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      this.rethrowPhotoActivationConflict(error);
    }
  }

  /**
   * Salon onboarding gate: a salon created from a field-employee onboarding application opens
   * for the first time only after a FastQue admin has recorded the publication decision. Salons
   * registered by their owners directly have no application and are unaffected.
   */
  private async assertOnboardingPublishAuthorized(
    salonId: string,
    db: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    const application = await db.salonOnboardingApplication.findUnique({
      where: { salonId },
      select: { publishAuthorizedAt: true },
    });
    if (application && !application.publishAuthorizedAt) {
      throw new AppException(
        OnboardingErrorCode.PUBLISH_NOT_AUTHORIZED,
        'FastQue is still reviewing this salon. It goes live once the FastQue team approves publication.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Keeps an onboarding application's status in step with its salon's real lifecycle status. */
  private async syncOnboardingApplication(
    tx: Prisma.TransactionClient,
    salonId: string,
    status: SalonStatus,
    actorId: string,
  ): Promise<void> {
    const application = await tx.salonOnboardingApplication.findUnique({
      where: { salonId },
      select: { id: true, status: true, publishedAt: true },
    });
    const target =
      status === SalonStatus.ACTIVE
        ? 'ACTIVE'
        : status === SalonStatus.SUSPENDED
          ? 'SUSPENDED'
          : null;
    if (!application || !target || application.status === target) return;
    const now = new Date();
    await tx.salonOnboardingApplication.update({
      where: { id: application.id },
      data: {
        status: target,
        ...(target === 'ACTIVE'
          ? { publishedAt: application.publishedAt ?? now, suspendedAt: null }
          : { suspendedAt: now }),
      },
    });
    await tx.salonOnboardingStatusHistory.create({
      data: {
        applicationId: application.id,
        previousStatus: application.status,
        newStatus: target,
        actorId,
        reason:
          target === 'ACTIVE' ? 'Salon is live on FastQue' : 'Salon suspended',
      },
    });
  }

  private async assertPhotoReadyToActivate(
    salonId: string,
    marker: boolean | null,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    // This method is called only for PENDING activation. A legacy PENDING shop is not covered
    // by the ACTIVE/SUSPENDED grandfathering exception.
    if (marker === true) return;
    const photos = await db.photo.findMany({
      where: { salonId },
      select: { url: true },
    });
    const readiness = this.toPhotoReadiness(photos, false);
    if (readiness.ready) return;
    throw new AppException(
      SalonSetupErrorCode.SHOP_PHOTOS_REQUIRED,
      'Add three distinct valid shop photos before opening your shop.',
      HttpStatus.CONFLICT,
      { ...readiness },
    );
  }

  private toPhotoReadiness(
    photos: Array<{ url: string }>,
    grandfathered: boolean,
  ): SalonPhotoActivationReadinessDto {
    const unique = new Set<string>();
    for (const photo of photos) {
      const parsed = salonPhotoUrlSchema.safeParse(photo.url);
      if (!parsed.success) continue;
      const normalized = new URL(parsed.data);
      normalized.search = '';
      normalized.hash = '';
      unique.add(normalized.toString());
    }
    const current = unique.size;
    const ready = grandfathered || current >= 3;
    return {
      required: 3,
      current,
      ready,
      grandfathered,
      reasons: ready ? [] : ['THREE_VALID_PHOTOS_REQUIRED'],
    };
  }

  private isGrandfathered(
    status: SalonStatus,
    marker: boolean | null,
  ): boolean {
    return (
      marker === true ||
      (marker === null &&
        (status === SalonStatus.ACTIVE || status === SalonStatus.SUSPENDED))
    );
  }

  private rethrowPhotoActivationConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    ) {
      throw new AppException(
        'SALON_ACTIVATION_REQUIREMENTS_CHANGED',
        'Shop setup changed while activation was in progress. Refresh and try again.',
        HttpStatus.CONFLICT,
      );
    }
    throw error;
  }

  /**
   * Throws SALON_SETUP_INCOMPLETE unless the salon has at least one active service, chair and
   * staff member — the three things without which a customer who finds the shop cannot actually
   * be served. The thrown error carries a SalonSetupReadinessDto in `details` so the client can
   * tick off what's already done instead of restating the whole requirement.
   */
  async assertReadyToOpen(
    salonId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const [serviceCount, chairCount, staffCount] = await Promise.all([
      db.service.count({ where: { salonId, isActive: true } }),
      db.chair.count({
        where: { salonId, status: ChairStatus.ACTIVE },
      }),
      db.salonStaff.count({
        where: { salonId, status: StaffMemberStatus.ACTIVE },
      }),
    ]);

    const readiness: SalonSetupReadinessDto = {
      hasActiveService: serviceCount > 0,
      hasActiveChair: chairCount > 0,
      hasActiveStaff: staffCount > 0,
    };
    if (
      readiness.hasActiveService &&
      readiness.hasActiveChair &&
      readiness.hasActiveStaff
    ) {
      return;
    }

    const missing = [
      readiness.hasActiveService ? null : 'one service',
      readiness.hasActiveChair ? null : 'one chair',
      readiness.hasActiveStaff ? null : 'one barber',
    ].filter((m): m is string => m !== null);

    throw new AppException(
      SalonSetupErrorCode.SALON_SETUP_INCOMPLETE,
      `Complete your shop setup before opening it: add at least ${formatList(missing)}.`,
      HttpStatus.CONFLICT,
      { ...readiness },
    );
  }
}

/** "one chair" | "one chair and one barber" | "one service, one chair and one barber" */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
