import { Prisma } from '@prisma/client';
import {
  EMPLOYEE_PATHS,
  ADMIN_PATHS,
  onboardingMissingFields,
  type AdminOnboardingApplicationDto,
  type OnboardingApplicationDto,
  type OnboardingHoursDto,
  type OnboardingInvitationDto,
  type OnboardingMediaDto,
  type OnboardingServiceDto,
} from '@barbercue/shared';
import { maskPhone } from '../admin/admin-monitoring.service';

export const APPLICATION_INCLUDE = {
  assignedEmployee: {
    select: { id: true, fullName: true, employeeCode: true, userId: true },
  },
  reviewer: {
    select: {
      id: true,
      email: true,
      employeeProfile: { select: { fullName: true } },
    },
  },
  salon: { select: { publicId: true } },
  hours: { orderBy: { dayOfWeek: 'asc' } },
  services: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  media: {
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: {
      uploadedBy: {
        select: {
          email: true,
          employeeProfile: { select: { fullName: true } },
        },
      },
    },
  },
} satisfies Prisma.SalonOnboardingApplicationInclude;

export const ADMIN_APPLICATION_INCLUDE = {
  ...APPLICATION_INCLUDE,
  statusHistory: {
    orderBy: { createdAt: 'asc' },
    include: {
      actor: {
        select: {
          email: true,
          employeeProfile: { select: { fullName: true } },
        },
      },
    },
  },
  reviews: {
    orderBy: { reviewedAt: 'asc' },
    include: {
      reviewer: {
        select: {
          email: true,
          employeeProfile: { select: { fullName: true } },
        },
      },
    },
  },
  invitations: { orderBy: { createdAt: 'desc' } },
} satisfies Prisma.SalonOnboardingApplicationInclude;

export type ApplicationWithRelations =
  Prisma.SalonOnboardingApplicationGetPayload<{
    include: typeof APPLICATION_INCLUDE;
  }>;
export type AdminApplicationWithRelations =
  Prisma.SalonOnboardingApplicationGetPayload<{
    include: typeof ADMIN_APPLICATION_INCLUDE;
  }>;

/** "HH:mm" <-> a Prisma TIME value (a Date on 1970-01-01 UTC). */
export function timeToDate(value: string): Date {
  return new Date(`1970-01-01T${value}:00.000Z`);
}
export function dateToTime(value: Date | null): string | null {
  return value ? value.toISOString().slice(11, 16) : null;
}

export function personName(
  user: {
    email: string | null;
    employeeProfile: { fullName: string } | null;
  } | null,
): string | null {
  if (!user) return null;
  return user.employeeProfile?.fullName ?? user.email ?? 'FastQue admin';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const num = (d: Prisma.Decimal | null): number | null =>
  d === null ? null : Number(d);

export function toHoursDto(
  rows: ApplicationWithRelations['hours'],
): OnboardingHoursDto[] {
  return rows.map((h) => ({
    dayOfWeek: h.dayOfWeek,
    isClosed: h.isClosed,
    opensAt: dateToTime(h.opensAt),
    closesAt: dateToTime(h.closesAt),
    closesNextDay: h.closesNextDay,
  }));
}

export function toServiceDto(
  s: ApplicationWithRelations['services'][number],
): OnboardingServiceDto {
  return {
    id: s.id,
    serviceName: s.serviceName,
    category: s.category,
    applicableGender: s.applicableGender,
    basePrice: num(s.basePrice),
    priceType: s.priceType,
    discountedPrice: num(s.discountedPrice),
    durationMinutes: s.durationMinutes,
    description: s.description,
    isActive: s.isActive,
    sourceType: s.sourceType,
    sourceMediaId: s.sourceMediaId,
    sourcePage: s.sourcePage,
    extractionConfidence: s.extractionConfidence,
    uncertainFields: s.uncertainFields,
    confirmedByEmployee: s.confirmedByEmployee,
  };
}

function toMediaDto(
  m: ApplicationWithRelations['media'][number],
  audience: 'employee' | 'admin',
): OnboardingMediaDto {
  const base =
    audience === 'employee'
      ? `${EMPLOYEE_PATHS.employee}/${EMPLOYEE_PATHS.onboarding}`
      : `${ADMIN_PATHS.admin}/${ADMIN_PATHS.onboarding}`;
  return {
    id: m.id,
    category: m.category,
    originalFilename: m.originalFilename,
    mimeType: m.mimeType,
    fileSize: m.fileSize,
    width: m.width,
    height: m.height,
    uploadedBy: personName(m.uploadedBy) ?? 'Unknown',
    createdAt: m.createdAt.toISOString(),
    filePath: `${base}/${m.applicationId}/${EMPLOYEE_PATHS.media}/${m.id}/${EMPLOYEE_PATHS.file}`,
  };
}

export function completenessOf(app: ApplicationWithRelations) {
  return onboardingMissingFields({
    ...app,
    hours: toHoursDto(app.hours),
    services: app.services.map((s) => ({ ...s, basePrice: num(s.basePrice) })),
    media: app.media,
  });
}

export function toApplicationDto(
  app: ApplicationWithRelations,
  opts: { audience: 'employee' | 'admin'; canEdit: boolean },
): OnboardingApplicationDto {
  return {
    id: app.id,
    reference: app.reference,
    version: app.version,
    status: app.status,
    leadId: app.leadId,
    salonId: app.salonId,
    salonPublicId: app.salon?.publicId ?? null,
    assignedEmployee: {
      id: app.assignedEmployee.id,
      fullName: app.assignedEmployee.fullName,
      employeeCode: app.assignedEmployee.employeeCode,
    },
    territory: app.territory,
    reviewer: app.reviewer
      ? {
          id: app.reviewer.id,
          name: personName(app.reviewer) ?? 'FastQue admin',
        }
      : null,
    canEdit: opts.canEdit,

    salonName: app.salonName,
    genderCategory: app.genderCategory,
    salonKind: app.salonKind,
    description: app.description,
    brandName: app.brandName,
    websiteUrl: app.websiteUrl,
    instagramUrl: app.instagramUrl,
    mapsUrl: app.mapsUrl,
    isFranchise: app.isFranchise,
    branchCount: app.branchCount,

    ownerName: app.ownerName,
    ownerPhone: app.ownerPhone,
    ownerWhatsapp: app.ownerWhatsapp,
    ownerEmail: app.ownerEmail,
    alternatePhone: app.alternatePhone,
    managerName: app.managerName,
    managerPhone: app.managerPhone,
    preferredLanguage: app.preferredLanguage,

    shopNumber: app.shopNumber,
    buildingName: app.buildingName,
    streetAddress: app.streetAddress,
    locality: app.locality,
    city: app.city,
    district: app.district,
    state: app.state,
    postalCode: app.postalCode,
    country: app.country,
    landmark: app.landmark,
    coordinates:
      app.latitude !== null && app.longitude !== null
        ? {
            latitude: app.latitude,
            longitude: app.longitude,
            source: app.coordinatesSource ?? 'MANUAL',
          }
        : null,

    employeeCount: app.employeeCount,
    chairCount: app.chairCount,
    activeChairCount: app.activeChairCount,
    maleStaffCount: app.maleStaffCount,
    femaleStaffCount: app.femaleStaffCount,
    walkInsAccepted: app.walkInsAccepted,
    bookingsAccepted: app.bookingsAccepted,
    liveQueueSupported: app.liveQueueSupported,
    appointmentIntervalMinutes: app.appointmentIntervalMinutes,
    averageServiceMinutes: app.averageServiceMinutes,
    specialTimings: app.specialTimings,
    hours: toHoursDto(app.hours),

    consentContact: app.consentContact,
    consentListing: app.consentListing,
    consentAccuracy: app.consentAccuracy,
    consentAuthorization: app.consentAuthorization,
    consentCapturedAt: iso(app.consentCapturedAt),
    gstin: app.gstin,
    businessRegistration: app.businessRegistration,
    employeeNotes: app.employeeNotes,
    openQuestions: app.openQuestions,

    services: app.services.map(toServiceDto),
    media: app.media.map((m) => toMediaDto(m, opts.audience)),
    missing: completenessOf(app),
    changeRequest:
      (app.changeRequest as Array<{ field: string; message: string }> | null) ??
      null,
    rejectionReason: app.rejectionReason,
    photoExceptionReason: app.photoExceptionReason,

    firstSubmittedAt: iso(app.firstSubmittedAt),
    submittedAt: iso(app.submittedAt),
    approvedAt: iso(app.approvedAt),
    rejectedAt: iso(app.rejectedAt),
    publishAuthorizedAt: iso(app.publishAuthorizedAt),
    publishedAt: iso(app.publishedAt),
    createdAt: app.createdAt.toISOString(),
    updatedAt: app.updatedAt.toISOString(),
  };
}

export function toInvitationDto(
  inv: AdminApplicationWithRelations['invitations'][number],
  now = new Date(),
): OnboardingInvitationDto {
  return {
    id: inv.id,
    status: inv.status,
    channel: inv.channel,
    attempts: inv.attempts,
    lastError: inv.lastError,
    sentAt: iso(inv.sentAt),
    expiresAt: inv.expiresAt.toISOString(),
    acceptedAt: iso(inv.acceptedAt),
    expired:
      inv.status !== 'ACCEPTED' && inv.expiresAt.getTime() <= now.getTime(),
  };
}

export function toAdminApplicationDto(
  app: AdminApplicationWithRelations,
  opts: { maskPii: boolean; canDecide: boolean },
): AdminOnboardingApplicationDto {
  const dto = toApplicationDto(app, { audience: 'admin', canEdit: false });
  if (opts.maskPii) {
    dto.ownerPhone = maskPhone(dto.ownerPhone);
    dto.ownerWhatsapp = maskPhone(dto.ownerWhatsapp);
    dto.alternatePhone = maskPhone(dto.alternatePhone);
    dto.managerPhone = maskPhone(dto.managerPhone);
    dto.ownerEmail = dto.ownerEmail
      ? `${dto.ownerEmail.slice(0, 2)}***@***`
      : null;
  }
  return {
    ...dto,
    internalNotes: app.internalNotes,
    statusHistory: app.statusHistory.map((h) => ({
      previousStatus: h.previousStatus,
      newStatus: h.newStatus,
      actorName: personName(h.actor),
      reason: h.reason,
      createdAt: h.createdAt.toISOString(),
    })),
    reviews: app.reviews.map((r) => ({
      id: r.id,
      reviewerName: personName(r.reviewer) ?? 'FastQue admin',
      decision: r.decision,
      comments: r.comments,
      details: r.details,
      applicationVersion: r.applicationVersion,
      reviewedAt: r.reviewedAt.toISOString(),
    })),
    invitations: app.invitations.map((i) => toInvitationDto(i)),
    ownerPhoneMasked: opts.maskPii,
    canDecide: opts.canDecide,
  };
}
