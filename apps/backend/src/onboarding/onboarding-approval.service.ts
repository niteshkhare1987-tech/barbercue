import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ChairStatus, Prisma, SalonType, UserStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import {
  ONBOARDING_APPROVED_STATUSES,
  ONBOARDING_INVITE_DEFAULT_TTL_HOURS,
  OnboardingErrorCode,
  currencyForCountry,
  type AuthenticatedUser,
  type OnboardingApprovalResultDto,
  type OnboardingApproveInput,
  type OnboardingInvitationDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConsoleEmailSender,
  EMAIL_SENDER,
  type EmailSender,
} from '../auth/services/email-sender';
import {
  buildPasswordLink,
  passwordWebBaseUrl,
} from '../auth/services/password-link';
import { resolveAutoTimezone } from '../common/timezone/timezone-resolution';
import { AdminOnboardingService } from './admin-onboarding.service';
import {
  assertOnboardingTransition,
  canOnboardingTransition,
} from './onboarding-transitions';
import { dateToTime } from './onboarding.mapper';
import { onboardingNotFound, writeStatusHistory } from './onboarding.service';
import { OnboardingNotifierService } from './onboarding-notifier.service';

const GENDER_TO_SALON_TYPE = {
  MEN: SalonType.GENTS,
  WOMEN: SalonType.LADIES,
  UNISEX: SalonType.UNISEX,
} as const;

export function inviteTtlHours(): number {
  const raw = Number(process.env.ONBOARDING_INVITE_TTL_HOURS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 24 * 14
    ? raw
    : ONBOARDING_INVITE_DEFAULT_TTL_HOURS;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'shop'
  );
}

interface PreparedInvite {
  invitationId: string;
  rawToken: string;
  email: string;
}

/**
 * Approval is where an application becomes a real (still non-public) FastQue salon. It runs in
 * one SERIALIZABLE transaction so it is idempotent: a second click or a network retry finds the
 * application already APPROVED with a salonId and returns that result instead of creating a
 * second salon or owner. The invitation email is sent only after the commit; a failed send is
 * recorded on the invitation row and the approved salon is kept so an admin can retry.
 */
@Injectable()
export class OnboardingApprovalService {
  private readonly logger = new Logger(OnboardingApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminOnboardingService,
    private readonly notifier: OnboardingNotifierService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
  ) {}

  async approve(
    user: AuthenticatedUser,
    id: string,
    input: OnboardingApproveInput,
  ): Promise<OnboardingApprovalResultDto> {
    let outcome: Awaited<ReturnType<OnboardingApprovalService['approveInTx']>>;
    try {
      outcome = await this.prisma.$transaction(
        (tx) => this.approveInTx(tx, user, id, input),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20_000,
        },
      );
    } catch (err) {
      // A concurrent duplicate request lost the serialization race (P2034, or P2010 / SQLSTATE
      // 40001 when the losing statement was the raw row lock); the winner's result stands.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2034' ||
          err.code === 'P2002' ||
          (err.code === 'P2010' &&
            /40001|could not serialize/i.test(err.message)))
      ) {
        const existing =
          await this.prisma.salonOnboardingApplication.findUnique({
            where: { id },
          });
        if (existing?.salonId)
          return this.result(user, id, { alreadyApproved: true });
      }
      throw err;
    }
    if (outcome.alreadyApproved)
      return this.result(user, id, { alreadyApproved: true });

    let devInviteUrl: string | undefined;
    if (outcome.invite) {
      devInviteUrl = await this.deliver(outcome.invite, outcome.salonName, id);
    }
    await this.notifier.toEmployee(
      outcome.assignedEmployeeId,
      'onboarding.approved',
      id,
      {
        reference: outcome.reference,
        salonName: outcome.salonName,
      },
    );
    if (outcome.ownerLinkedExisting) {
      await this.notifier.toUser(
        outcome.ownerUserId,
        'onboarding.approved',
        { salonName: outcome.salonName },
        `owner/salons/${outcome.salonId}`,
      );
    }
    return this.result(user, id, {
      alreadyApproved: false,
      devInviteUrl,
      servicesNeedingOwnerInput: outcome.servicesNeedingOwnerInput,
      hoursNeedingOwnerInput: outcome.hoursNeedingOwnerInput,
      ownerLinkedExisting: outcome.ownerLinkedExisting,
    });
  }

  private async approveInTx(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    id: string,
    input: OnboardingApproveInput,
  ) {
    const app = await this.admin.lockForDecision(tx, user, id);
    if (app.salonId && ONBOARDING_APPROVED_STATUSES.includes(app.status)) {
      return { alreadyApproved: true as const };
    }
    this.admin.assertVersion(app.version, input.applicationVersion);
    const next = assertOnboardingTransition('APPROVE', app.status, 'ADMIN');
    await this.admin.assertComplete(tx, id);
    if (!app.consentContact || !app.consentListing) {
      throw new AppException(
        OnboardingErrorCode.CONSENT_REQUIRED,
        'Owner consent to contact and listing is required before approval.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 1. City must already exist in FastQue's city master; never created from free text.
    const cities = await tx.city.findMany({
      where: { name: { equals: app.city?.trim() ?? '', mode: 'insensitive' } },
      select: { id: true, countryCode: true, timezone: true, name: true },
    });
    if (cities.length !== 1) {
      throw new AppException(
        OnboardingErrorCode.CITY_NOT_SUPPORTED,
        cities.length
          ? `More than one FastQue city is called "${app.city}". Correct the city before approving.`
          : `"${app.city}" is not a FastQue city yet. Add the city or correct the application before approving.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const city = cities[0];

    // 2. Owner identity: link an existing account (multi-branch owners) or create one with no
    //    password. Phone and email must not point at two different people.
    const phone = app.ownerPhone;
    const email = app.ownerEmail?.toLowerCase() ?? null;
    const candidates = await tx.user.findMany({
      where: {
        OR: [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : [])],
      },
      select: {
        id: true,
        phone: true,
        email: true,
        status: true,
        deletedAt: true,
        passwordHash: true,
        phoneVerifiedAt: true,
        emailVerifiedAt: true,
      },
    });
    const byPhone = phone
      ? candidates.find((u) => u.phone === phone)
      : undefined;
    const byEmail = email
      ? candidates.find((u) => u.email?.toLowerCase() === email)
      : undefined;
    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      throw new AppException(
        OnboardingErrorCode.OWNER_IDENTITY_CONFLICT,
        'The owner phone and email belong to two different FastQue accounts. Correct one of them before approving.',
        HttpStatus.CONFLICT,
      );
    }
    const existing = byPhone ?? byEmail;
    if (
      existing &&
      (existing.status !== UserStatus.ACTIVE || existing.deletedAt)
    ) {
      throw new AppException(
        OnboardingErrorCode.OWNER_ACCOUNT_UNAVAILABLE,
        'The owner account linked to this phone or email is suspended or deleted.',
        HttpStatus.CONFLICT,
      );
    }
    const owner =
      existing ??
      (await tx.user.create({
        data: { phone, email, preferredLanguage: 'EN' },
        select: {
          id: true,
          phone: true,
          email: true,
          status: true,
          deletedAt: true,
          passwordHash: true,
          phoneVerifiedAt: true,
          emailVerifiedAt: true,
        },
      }));
    const ownerAlreadyActive =
      !!existing &&
      !!existing.passwordHash &&
      !!(existing.emailVerifiedAt || existing.phoneVerifiedAt);

    // 3. The master salon, PENDING (never discoverable until a separate publish decision).
    const base = slugify(app.salonName);
    const taken = new Set(
      (
        await tx.salon.findMany({
          where: { cityId: city.id, slug: { startsWith: base } },
          select: { slug: true },
        })
      ).map((s) => s.slug),
    );
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    const tz = resolveAutoTimezone({
      latitude: app.latitude,
      longitude: app.longitude,
      cityTimezone: city.timezone,
      countryCode: city.countryCode,
    });
    const addressLine = [app.shopNumber, app.buildingName, app.streetAddress]
      .filter(Boolean)
      .join(', ');
    const salon = await tx.salon.create({
      data: {
        ownerUserId: owner.id,
        name: app.salonName,
        slug,
        cityId: city.id,
        localityText: app.locality,
        landmark: app.landmark,
        addressLine,
        postalCode: app.postalCode,
        lat: app.latitude,
        lng: app.longitude,
        currency: currencyForCountry(city.countryCode),
        timezone: tz?.timezone ?? null,
        timezoneAutoDetected: Boolean(tz),
        // Owner contact stays private until the owner chooses to show it.
        phone,
        showPhoneToCustomers: false,
        description: app.description,
        salonType: app.genderCategory
          ? GENDER_TO_SALON_TYPE[app.genderCategory]
          : SalonType.UNISEX,
        status: 'PENDING',
        shopPhotoRequirementGrandfathered: false,
      },
      select: { id: true },
    });
    await tx.userRole.upsert({
      where: {
        userId_role_salonId: {
          userId: owner.id,
          role: 'SALON_OWNER',
          salonId: salon.id,
        },
      },
      update: {},
      create: { userId: owner.id, role: 'SALON_OWNER', salonId: salon.id },
    });

    // 4. Hours: same-day ranges copy as-is; past-midnight days are left for the owner because the
    //    salon schedule format cannot express them.
    const hours = await tx.salonOnboardingHours.findMany({
      where: { applicationId: id },
    });
    const hoursNeedingOwnerInput: number[] = [];
    const hourRows: Prisma.OperatingHoursCreateManyInput[] = [];
    for (const h of hours) {
      if (h.isClosed) {
        hourRows.push({
          salonId: salon.id,
          dayOfWeek: h.dayOfWeek,
          openTime: '00:00',
          closeTime: '00:00',
          isClosed: true,
        });
      } else if (h.closesNextDay) {
        hoursNeedingOwnerInput.push(h.dayOfWeek);
      } else {
        hourRows.push({
          salonId: salon.id,
          dayOfWeek: h.dayOfWeek,
          openTime: dateToTime(h.opensAt) as string,
          closeTime: dateToTime(h.closesAt) as string,
          isClosed: false,
        });
      }
    }
    if (hourRows.length) await tx.operatingHours.createMany({ data: hourRows });

    // 5. Chairs exactly as counted on the visit.
    const total = app.chairCount ?? 0;
    const active = Math.min(app.activeChairCount ?? total, total);
    if (total > 0) {
      await tx.chair.createMany({
        data: Array.from({ length: total }, (_, i) => ({
          salonId: salon.id,
          label: `Chair ${i + 1}`,
          status: i < active ? ChairStatus.ACTIVE : ChairStatus.INACTIVE,
        })),
      });
    }

    // 6. Confirmed services only. Anything without a price or duration is reported, not guessed.
    const services = await tx.salonOnboardingService.findMany({
      where: { applicationId: id, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    const servicesNeedingOwnerInput: string[] = [];
    const serviceRows: Prisma.ServiceCreateManyInput[] = [];
    for (const s of services) {
      if (
        !s.confirmedByEmployee ||
        s.basePrice === null ||
        !s.durationMinutes
      ) {
        servicesNeedingOwnerInput.push(s.serviceName);
        continue;
      }
      const priceNote =
        s.priceType === 'STARTS_FROM'
          ? `Price starts from ₹${Number(s.basePrice)}.`
          : null;
      serviceRows.push({
        salonId: salon.id,
        name: s.serviceName,
        durationMinutes: s.durationMinutes,
        price: s.basePrice,
        category: s.category,
        description:
          [priceNote, s.description].filter(Boolean).join(' ') || null,
        isActive: true,
      });
    }
    if (serviceRows.length) await tx.service.createMany({ data: serviceRows });

    // 7. CRM attribution: the original lead is now an onboarded shop.
    await tx.employeeCrmLead.updateMany({
      where: { id: app.leadId, onboardedSalonId: null },
      data: {
        status: 'ONBOARDED',
        onboardedSalonId: salon.id,
        onboardedAt: new Date(),
      },
    });

    // 8. Application + review trail.
    const now = new Date();
    await tx.salonOnboardingApplication.update({
      where: { id },
      data: {
        status: next,
        salonId: salon.id,
        approvedAt: now,
        approvedById: user.id,
        approvedVersion: app.version,
        reviewerId: app.reviewerId ?? user.id,
      },
    });
    await tx.salonOnboardingReview.create({
      data: {
        applicationId: id,
        reviewerId: user.id,
        decision: 'APPROVE',
        comments: input.notes ?? null,
        details: {
          salonId: salon.id,
          ownerUserId: owner.id,
          linkedExistingOwner: !!existing,
        },
        applicationVersion: app.version,
      },
    });
    await writeStatusHistory(
      tx,
      id,
      app.status,
      next,
      user.id,
      input.notes ?? 'Approved',
    );
    await tx.auditLog.create({
      data: {
        actorUserId: user.id,
        action: 'ONBOARDING_APPROVED',
        entityType: 'SalonOnboardingApplication',
        entityId: id,
        metadata: {
          salonId: salon.id,
          ownerUserId: owner.id,
          version: app.version,
        },
      },
    });

    // 9. Owner account activation path.
    let invite: PreparedInvite | null = null;
    if (ownerAlreadyActive) {
      const activated = assertOnboardingTransition(
        'OWNER_ACTIVATED',
        next,
        'SYSTEM',
      );
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { status: activated },
      });
      await writeStatusHistory(
        tx,
        id,
        next,
        activated,
        null,
        'Linked to an existing, verified owner account',
      );
    } else {
      invite = await this.prepareInvite(tx, id, owner.id, owner.email, user.id);
    }
    return {
      alreadyApproved: false as const,
      salonId: salon.id,
      salonName: app.salonName,
      reference: app.reference,
      assignedEmployeeId: app.assignedEmployeeId,
      ownerUserId: owner.id,
      ownerLinkedExisting: !!existing,
      servicesNeedingOwnerInput,
      hoursNeedingOwnerInput,
      invite,
    };
  }

  /**
   * Creates a single-use, expiring token (only its sha256 is stored, in PasswordResetToken) and
   * an invitation row. Without an email there is no configured channel: the invitation is
   * recorded as DELIVERY_UNAVAILABLE rather than pretending an SMS went out.
   */
  private async prepareInvite(
    tx: Prisma.TransactionClient,
    applicationId: string,
    ownerUserId: string,
    email: string | null,
    actorId: string,
  ): Promise<PreparedInvite | null> {
    const expiresAt = new Date(Date.now() + inviteTtlHours() * 3_600_000);
    if (!email) {
      await tx.salonOnboardingInvitation.create({
        data: {
          applicationId,
          ownerUserId,
          status: 'DELIVERY_UNAVAILABLE',
          lastError:
            'Owner has no email address and no SMS provider is configured.',
          createdById: actorId,
          expiresAt,
        },
      });
      await this.moveTo(
        tx,
        applicationId,
        'INVITE_FAILED',
        actorId,
        'Invitation could not be sent: no email address',
      );
      return null;
    }
    const rawToken = randomBytes(32).toString('hex');
    const token = await tx.passwordResetToken.create({
      data: { userId: ownerUserId, tokenHash: sha256(rawToken), expiresAt },
      select: { id: true },
    });
    const invitation = await tx.salonOnboardingInvitation.create({
      data: {
        applicationId,
        ownerUserId,
        passwordResetTokenId: token.id,
        status: 'PENDING',
        createdById: actorId,
        expiresAt,
      },
      select: { id: true },
    });
    return { invitationId: invitation.id, rawToken, email };
  }

  /** Sends after commit and records the truthful outcome. Returns the dev capture link, if any. */
  private async deliver(
    invite: PreparedInvite,
    salonName: string,
    applicationId: string,
  ): Promise<string | undefined> {
    const captured = this.emailSender instanceof ConsoleEmailSender;
    let url: string;
    try {
      url = buildPasswordLink(
        passwordWebBaseUrl(),
        invite.rawToken,
        'owner',
        'invite',
      );
      this.emailSender.assertAvailable();
      await this.emailSender.sendOwnerInvitation(
        invite.email,
        salonName,
        url,
        inviteTtlHours(),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown delivery error';
      this.logger.warn(
        `Owner invitation delivery failed for application ${applicationId}: ${message}`,
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.salonOnboardingInvitation.update({
          where: { id: invite.invitationId },
          data: {
            status: 'FAILED',
            attempts: { increment: 1 },
            lastError: message.slice(0, 300),
          },
        });
        await this.moveTo(
          tx,
          applicationId,
          'INVITE_FAILED',
          null,
          'Invitation delivery failed; admin can retry',
        );
      });
      return undefined;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.salonOnboardingInvitation.update({
        where: { id: invite.invitationId },
        data: {
          status: captured ? 'CAPTURED_DEV' : 'SENT',
          attempts: { increment: 1 },
          sentAt: new Date(),
          lastError: captured
            ? 'Development capture only: no email left this machine.'
            : null,
        },
      });
      await this.moveTo(
        tx,
        applicationId,
        'INVITE_SENT',
        null,
        captured
          ? 'Invitation captured in development (not delivered)'
          : 'Invitation accepted by the email provider',
      );
    });
    return process.env.NODE_ENV === 'production' ? undefined : url;
  }

  private async moveTo(
    tx: Prisma.TransactionClient,
    applicationId: string,
    action: 'INVITE_SENT' | 'INVITE_FAILED',
    actorId: string | null,
    reason: string,
  ): Promise<void> {
    const app = await tx.salonOnboardingApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: { status: true },
    });
    if (!canOnboardingTransition(action, app.status, 'SYSTEM')) return;
    const next = assertOnboardingTransition(action, app.status, 'SYSTEM');
    if (next === app.status) return;
    await tx.salonOnboardingApplication.update({
      where: { id: applicationId },
      data: { status: next },
    });
    await writeStatusHistory(
      tx,
      applicationId,
      app.status,
      next,
      actorId,
      reason,
    );
  }

  /** Revokes any open invitation and issues a fresh token. Allowed until the owner accepts. */
  async resendInvitation(
    user: AuthenticatedUser,
    id: string,
  ): Promise<OnboardingApprovalResultDto> {
    const prepared = await this.prisma.$transaction(async (tx) => {
      const app = await this.admin.lockForDecision(tx, user, id);
      if (
        !app.salonId ||
        !['APPROVED', 'OWNER_INVITED', 'AWAITING_OWNER_ACTIVATION'].includes(
          app.status,
        )
      ) {
        throw new AppException(
          OnboardingErrorCode.INVITATION_NOT_RETRYABLE,
          'An invitation can only be resent for an approved salon whose owner has not activated yet.',
          HttpStatus.CONFLICT,
        );
      }
      const salon = await tx.salon.findUniqueOrThrow({
        where: { id: app.salonId },
        select: { ownerUserId: true, owner: { select: { email: true } } },
      });
      const open = await tx.salonOnboardingInvitation.findMany({
        where: {
          applicationId: id,
          status: {
            in: [
              'PENDING',
              'SENT',
              'CAPTURED_DEV',
              'FAILED',
              'DELIVERY_UNAVAILABLE',
            ],
          },
        },
        select: { id: true, passwordResetTokenId: true },
      });
      for (const inv of open) {
        await tx.salonOnboardingInvitation.update({
          where: { id: inv.id },
          data: { status: 'REVOKED' },
        });
        if (inv.passwordResetTokenId) {
          await tx.passwordResetToken.updateMany({
            where: { id: inv.passwordResetTokenId, usedAt: null },
            data: { usedAt: new Date() },
          });
        }
      }
      // An admin may have corrected the email on the application; attach it if the account has none.
      let email = salon.owner.email;
      if (!email && app.ownerEmail) {
        const clash = await tx.user.findUnique({
          where: { email: app.ownerEmail },
        });
        if (!clash) {
          await tx.user.update({
            where: { id: salon.ownerUserId },
            data: { email: app.ownerEmail },
          });
          email = app.ownerEmail;
        }
      }
      return {
        invite: await this.prepareInvite(
          tx,
          id,
          salon.ownerUserId,
          email,
          user.id,
        ),
        salonName: app.salonName,
      };
    });
    const devInviteUrl = prepared.invite
      ? await this.deliver(prepared.invite, prepared.salonName, id)
      : undefined;
    return this.result(user, id, { alreadyApproved: false, devInviteUrl });
  }

  private async result(
    user: AuthenticatedUser,
    id: string,
    extra: Partial<OnboardingApprovalResultDto> & { alreadyApproved: boolean },
  ): Promise<OnboardingApprovalResultDto> {
    const application = await this.admin.get(user, id);
    const app = await this.prisma.salonOnboardingApplication.findUnique({
      where: { id },
      select: { salonId: true, salon: { select: { ownerUserId: true } } },
    });
    if (!app?.salonId || !app.salon) throw onboardingNotFound();
    const latest: OnboardingInvitationDto | null =
      application.invitations[0] ?? null;
    return {
      application,
      salonId: app.salonId,
      ownerUserId: app.salon.ownerUserId,
      ownerLinkedExisting: extra.ownerLinkedExisting ?? false,
      invitation: latest,
      ...(extra.devInviteUrl ? { devInviteUrl: extra.devInviteUrl } : {}),
      servicesNeedingOwnerInput: extra.servicesNeedingOwnerInput ?? [],
      hoursNeedingOwnerInput: extra.hoursNeedingOwnerInput ?? [],
      alreadyApproved: extra.alreadyApproved,
    };
  }
}
