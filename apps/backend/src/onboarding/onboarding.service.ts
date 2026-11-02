import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type OnboardingStatus } from '@prisma/client';
import {
  AuthErrorCode,
  CrmErrorCode,
  ONBOARDING_BUCKET_STATUSES,
  ONBOARDING_EMPLOYEE_EDITABLE,
  OnboardingErrorCode,
  normalizeIndianMobile,
  onboardingBucketFor,
  onboardingClosesNextDay,
  onboardingServiceKey,
  type CreateOnboardingInput,
  type OnboardingApplicationDto,
  type OnboardingBucket,
  type OnboardingCountsDto,
  type OnboardingDraftInput,
  type OnboardingDuplicateDto,
  type OnboardingListItemDto,
  type ReplaceOnboardingServicesInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  APPLICATION_INCLUDE,
  completenessOf,
  timeToDate,
  toApplicationDto,
  type ApplicationWithRelations,
} from './onboarding.mapper';
import { assertOnboardingTransition } from './onboarding-transitions';
import { OnboardingNotifierService } from './onboarding-notifier.service';
import { OnboardingDuplicatesService } from './onboarding-duplicates.service';

type Db = PrismaService | Prisma.TransactionClient;
type EmployeeProfileRow = {
  id: string;
  userId: string;
  territory: string | null;
  fullName: string;
};

/** Scalar draft fields -> Prisma columns. Undefined keys are left untouched. */
export function draftToData(
  input: Omit<OnboardingDraftInput, 'hours' | 'expectedVersion'>,
): Prisma.SalonOnboardingApplicationUncheckedUpdateInput {
  const { coordinates, ...rest } = input;
  const data: Prisma.SalonOnboardingApplicationUncheckedUpdateInput = {
    ...rest,
  };
  if (coordinates !== undefined) {
    data.latitude = coordinates?.latitude ?? null;
    data.longitude = coordinates?.longitude ?? null;
    data.coordinatesSource = coordinates?.source ?? null;
  }
  return data;
}

export function onboardingNotFound(): AppException {
  return new AppException(
    OnboardingErrorCode.NOT_FOUND,
    'Onboarding application not found.',
    HttpStatus.NOT_FOUND,
  );
}

export async function writeStatusHistory(
  db: Db,
  applicationId: string,
  previousStatus: OnboardingStatus | null,
  newStatus: OnboardingStatus,
  actorId: string | null,
  reason?: string | null,
): Promise<void> {
  await db.salonOnboardingStatusHistory.create({
    data: {
      applicationId,
      previousStatus,
      newStatus,
      actorId,
      reason: reason ?? null,
    },
  });
}

/** Rewrites the 7-day schedule. TIME columns; a close before the open means "past midnight". */
export async function replaceHours(
  db: Db,
  applicationId: string,
  hours: NonNullable<OnboardingDraftInput['hours']>,
): Promise<void> {
  await db.salonOnboardingHours.deleteMany({ where: { applicationId } });
  if (!hours.length) return;
  await db.salonOnboardingHours.createMany({
    data: hours.map((h) => ({
      applicationId,
      dayOfWeek: h.dayOfWeek,
      isClosed: h.isClosed,
      opensAt: !h.isClosed && h.opensAt ? timeToDate(h.opensAt) : null,
      closesAt: !h.isClosed && h.closesAt ? timeToDate(h.closesAt) : null,
      closesNextDay:
        !h.isClosed &&
        !!h.opensAt &&
        !!h.closesAt &&
        onboardingClosesNextDay(h.opensAt, h.closesAt),
    })),
  });
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: OnboardingNotifierService,
    private readonly duplicates: OnboardingDuplicatesService,
  ) {}

  // ---------- Creation ----------

  /** Option B: direct onboarding. A lead is created (or an unconverted one of the employee's
   * own with the same phone is linked) in the same transaction, so CRM attribution stays intact. */
  async create(
    userId: string,
    input: CreateOnboardingInput,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    const { hours, expectedVersion, ...fields } = input;
    void expectedVersion; // a brand-new application has no prior version
    const id = await this.prisma.$transaction(async (tx) => {
      const existingLead = fields.ownerPhone
        ? await tx.employeeCrmLead.findFirst({
            where: {
              employeeProfileId: profile.id,
              onboardingApplication: null,
              onboardedSalonId: null,
              OR: [
                { phone: fields.ownerPhone },
                { phone: fields.ownerPhone.slice(3) },
              ],
            },
            select: { id: true },
          })
        : null;
      const leadId =
        existingLead?.id ??
        (
          await tx.employeeCrmLead.create({
            data: {
              employeeProfileId: profile.id,
              shopName: fields.salonName,
              contactName: fields.ownerName ?? null,
              phone: fields.ownerPhone ?? null,
              email: fields.ownerEmail ?? null,
              city: fields.city ?? null,
              locality: fields.locality ?? null,
              addressLine: fields.streetAddress ?? null,
              source: 'FIELD_VISIT',
              status: 'INTERESTED',
              notes:
                'Created automatically from a salon onboarding application.',
            },
            select: { id: true },
          })
        ).id;
      return this.insertApplication(tx, profile, userId, leadId, fields, hours);
    });
    return this.get(userId, id);
  }

  /** Option A: convert an existing lead. Pre-fills only what the lead actually holds. */
  async createFromLead(
    userId: string,
    leadId: string,
    overrides: Partial<CreateOnboardingInput>,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    const lead = await this.prisma.employeeCrmLead.findFirst({
      where: { id: leadId, employeeProfileId: profile.id },
      include: { onboardingApplication: { select: { id: true } } },
    });
    if (!lead) {
      throw new AppException(
        CrmErrorCode.LEAD_NOT_FOUND,
        'Lead not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (lead.onboardingApplication) {
      throw new AppException(
        OnboardingErrorCode.LEAD_ALREADY_CONVERTED,
        'This lead already has an onboarding application.',
        HttpStatus.CONFLICT,
        { applicationId: lead.onboardingApplication.id },
      );
    }
    if (lead.status === 'ONBOARDED' || lead.onboardedSalonId) {
      throw new AppException(
        OnboardingErrorCode.LEAD_ALREADY_CONVERTED,
        'This lead is already attributed to a FastQue shop.',
        HttpStatus.CONFLICT,
      );
    }
    const prefill: Omit<CreateOnboardingInput, 'hours' | 'expectedVersion'> = {
      salonName: lead.shopName,
      ownerName: lead.contactName ?? null,
      // An unparseable lead phone is not guessed at; the employee re-enters it.
      ownerPhone: normalizeIndianMobile(lead.phone),
      ownerEmail: lead.email?.trim().toLowerCase() || null,
      city: lead.city ?? null,
      locality: lead.locality ?? null,
      streetAddress: lead.addressLine ?? null,
    };
    const { hours, expectedVersion, ...rest } = overrides;
    void expectedVersion;
    try {
      const id = await this.prisma.$transaction((tx) =>
        this.insertApplication(
          tx,
          profile,
          userId,
          lead.id,
          { ...prefill, ...rest },
          hours,
        ),
      );
      return this.get(userId, id);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new AppException(
          OnboardingErrorCode.LEAD_ALREADY_CONVERTED,
          'This lead already has an onboarding application.',
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  private async insertApplication(
    tx: Prisma.TransactionClient,
    profile: EmployeeProfileRow,
    userId: string,
    leadId: string,
    fields: Omit<CreateOnboardingInput, 'hours' | 'expectedVersion'>,
    hours: CreateOnboardingInput['hours'],
  ): Promise<string> {
    const data = draftToData(
      fields,
    ) as Prisma.SalonOnboardingApplicationUncheckedCreateInput;
    const created = await tx.salonOnboardingApplication.create({
      data: {
        ...data,
        salonName: fields.salonName,
        leadId,
        assignedEmployeeId: profile.id,
        createdByUserId: userId,
        territory: profile.territory,
        consentCapturedAt: this.allConsents(fields) ? new Date() : null,
      },
      select: { id: true },
    });
    if (hours) await replaceHours(tx, created.id, hours);
    await writeStatusHistory(
      tx,
      created.id,
      null,
      'DRAFT',
      userId,
      'Application started',
    );
    return created.id;
  }

  // ---------- Reads ----------

  async list(
    userId: string,
    bucket?: OnboardingBucket,
  ): Promise<OnboardingListItemDto[]> {
    const profile = await this.requireProfile(userId);
    const rows = await this.prisma.salonOnboardingApplication.findMany({
      where: {
        AND: [
          this.readableWhere(profile),
          bucket
            ? { status: { in: [...ONBOARDING_BUCKET_STATUSES[bucket]] } }
            : {},
        ],
      },
      include: APPLICATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => this.toListItem(r));
  }

  async counts(userId: string): Promise<OnboardingCountsDto> {
    const profile = await this.requireProfile(userId);
    const grouped = await this.prisma.salonOnboardingApplication.groupBy({
      by: ['status'],
      where: { assignedEmployeeId: profile.id },
      _count: { _all: true },
    });
    const counts: OnboardingCountsDto = {
      drafts: 0,
      pending: 0,
      changes: 0,
      approved: 0,
      activated: 0,
      rejected: 0,
    };
    for (const g of grouped)
      counts[onboardingBucketFor(g.status)] += g._count._all;
    return counts;
  }

  async get(userId: string, id: string): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    const app = await this.loadReadable(profile, id);
    return toApplicationDto(app, {
      audience: 'employee',
      canEdit: this.canEdit(profile, app),
    });
  }

  async duplicatesFor(
    userId: string,
    id: string,
  ): Promise<OnboardingDuplicateDto[]> {
    const profile = await this.requireProfile(userId);
    const app = await this.loadReadable(profile, id);
    return this.duplicates.find(app, true);
  }

  // ---------- Edits ----------

  async update(
    userId: string,
    id: string,
    input: OnboardingDraftInput,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    const { hours, expectedVersion, ...fields } = input;
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockEditable(tx, profile, id, expectedVersion);
      const merged = { ...app, ...fields };
      const consentNow = this.allConsents(merged);
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: {
          ...draftToData(fields),
          version: { increment: 1 },
          consentCapturedAt: consentNow
            ? (app.consentCapturedAt ?? new Date())
            : null,
        },
      });
      if (hours) await replaceHours(tx, id, hours);
    });
    return this.get(userId, id);
  }

  /**
   * Replaces the service list. Rows are merged on a name+gender key so the same service from two
   * menu photos and a manual row is stored once; the first price seen wins and conflicting
   * prices are surfaced as uncertain rather than silently chosen.
   */
  async replaceServices(
    userId: string,
    id: string,
    input: ReplaceOnboardingServicesInput,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockEditable(tx, profile, id, input.expectedVersion);
      const mediaIds = new Set(
        (
          await tx.salonOnboardingMedia.findMany({
            where: { applicationId: id, deletedAt: null },
            select: { id: true },
          })
        ).map((m) => m.id),
      );
      const rows = mergeServiceRows(input.services);
      await tx.salonOnboardingService.deleteMany({
        where: { applicationId: id },
      });
      if (rows.length) {
        await tx.salonOnboardingService.createMany({
          data: rows.map((row, index) => ({
            applicationId: id,
            serviceName: row.serviceName,
            normalizedKey: onboardingServiceKey(
              row.serviceName,
              row.applicableGender,
            ),
            category: row.category ?? null,
            applicableGender: row.applicableGender ?? null,
            basePrice: row.basePrice ?? null,
            priceType: row.priceType,
            discountedPrice: row.discountedPrice ?? null,
            durationMinutes: row.durationMinutes ?? null,
            description: row.description ?? null,
            isActive: row.isActive,
            sourceType: row.sourceType,
            sourceMediaId:
              row.sourceMediaId && mediaIds.has(row.sourceMediaId)
                ? row.sourceMediaId
                : null,
            sourcePage: row.sourcePage ?? null,
            extractionConfidence: row.extractionConfidence ?? null,
            uncertainFields: row.confirmedByEmployee
              ? []
              : (row.uncertainFields ?? []),
            confirmedByEmployee: row.confirmedByEmployee,
            sortOrder: index,
          })),
        });
      }
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { version: { increment: 1 } },
      });
    });
    return this.get(userId, id);
  }

  /** Server-side validation of every mandatory field, then DRAFT -> SUBMITTED or
   * CHANGES_REQUESTED -> RESUBMITTED. The application becomes read-only to the employee. */
  async submit(
    userId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<OnboardingApplicationDto> {
    const profile = await this.requireProfile(userId);
    const result = await this.prisma.$transaction(
      async (tx) => {
        await this.lockEditable(tx, profile, id, expectedVersion);
        const app = await tx.salonOnboardingApplication.findUniqueOrThrow({
          where: { id },
          include: APPLICATION_INCLUDE,
        });
        const missing = completenessOf(app);
        if (missing.length) {
          throw new AppException(
            OnboardingErrorCode.INCOMPLETE,
            'Some required information is missing.',
            HttpStatus.UNPROCESSABLE_ENTITY,
            { missing },
          );
        }
        const next = assertOnboardingTransition(
          'SUBMIT',
          app.status,
          'EMPLOYEE',
        );
        const now = new Date();
        await tx.salonOnboardingApplication.update({
          where: { id },
          data: {
            status: next,
            submittedAt: now,
            firstSubmittedAt: app.firstSubmittedAt ?? now,
            changeRequest: Prisma.DbNull,
          },
        });
        await writeStatusHistory(
          tx,
          id,
          app.status,
          next,
          userId,
          next === 'RESUBMITTED'
            ? 'Corrections resubmitted'
            : 'Submitted for review',
        );
        return { next, app };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.notifier.toAdmins('onboarding.submitted', id, {
      reference: result.app.reference,
      salonName: result.app.salonName,
      employee: profile.fullName,
      resubmitted: result.next === 'RESUBMITTED',
    });
    return this.get(userId, id);
  }

  // ---------- Access ----------

  async requireProfile(userId: string): Promise<EmployeeProfileRow> {
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { userId },
      select: { id: true, userId: true, territory: true, fullName: true },
    });
    if (!profile) {
      throw new AppException(
        AuthErrorCode.FORBIDDEN_ROLE,
        'Employee profile is not configured.',
        HttpStatus.FORBIDDEN,
      );
    }
    return profile;
  }

  /** Own applications, plus read-only access to those explicitly sharing the same territory. */
  readableWhere(
    profile: EmployeeProfileRow,
  ): Prisma.SalonOnboardingApplicationWhereInput {
    return profile.territory
      ? {
          OR: [
            { assignedEmployeeId: profile.id },
            { territory: profile.territory },
          ],
        }
      : { assignedEmployeeId: profile.id };
  }

  async loadReadable(
    profile: EmployeeProfileRow,
    id: string,
  ): Promise<ApplicationWithRelations> {
    const app = await this.prisma.salonOnboardingApplication.findFirst({
      where: { AND: [{ id }, this.readableWhere(profile)] },
      include: APPLICATION_INCLUDE,
    });
    // Same 404 for "missing" and "not yours", so ids cannot be probed.
    if (!app) throw onboardingNotFound();
    return app;
  }

  canEdit(
    profile: EmployeeProfileRow,
    app: { assignedEmployeeId: string; status: OnboardingStatus },
  ): boolean {
    return (
      app.assignedEmployeeId === profile.id &&
      ONBOARDING_EMPLOYEE_EDITABLE.includes(app.status)
    );
  }

  /** Row-locks the application and checks ownership, editability and (optionally) version. */
  async lockEditable(
    tx: Prisma.TransactionClient,
    profile: EmployeeProfileRow,
    id: string,
    expectedVersion?: number,
  ) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM salon_onboarding_applications WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw onboardingNotFound();
    const app = await tx.salonOnboardingApplication.findUniqueOrThrow({
      where: { id },
    });
    if (app.assignedEmployeeId !== profile.id) {
      const sharedRead =
        !!profile.territory && app.territory === profile.territory;
      if (!sharedRead) throw onboardingNotFound();
      throw new AppException(
        OnboardingErrorCode.NOT_EDITABLE,
        'Only the assigned employee can edit this application.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!ONBOARDING_EMPLOYEE_EDITABLE.includes(app.status)) {
      throw new AppException(
        OnboardingErrorCode.NOT_EDITABLE,
        'This application is with the review team and is read-only until changes are requested.',
        HttpStatus.CONFLICT,
      );
    }
    if (expectedVersion !== undefined && expectedVersion !== app.version) {
      throw new AppException(
        OnboardingErrorCode.VERSION_CONFLICT,
        'This application was changed elsewhere. Reload to see the latest version.',
        HttpStatus.CONFLICT,
        { currentVersion: app.version },
      );
    }
    return app;
  }

  private allConsents(v: {
    consentContact?: boolean;
    consentListing?: boolean;
    consentAccuracy?: boolean;
    consentAuthorization?: boolean;
  }): boolean {
    return !!(
      v.consentContact &&
      v.consentListing &&
      v.consentAccuracy &&
      v.consentAuthorization
    );
  }

  toListItem(
    r: ApplicationWithRelations,
    maskPhone?: (v: string | null) => string | null,
  ): OnboardingListItemDto {
    return {
      id: r.id,
      reference: r.reference,
      salonName: r.salonName,
      city: r.city,
      locality: r.locality,
      ownerName: r.ownerName,
      ownerPhone: maskPhone ? maskPhone(r.ownerPhone) : r.ownerPhone,
      employee: {
        id: r.assignedEmployee.id,
        fullName: r.assignedEmployee.fullName,
        employeeCode: r.assignedEmployee.employeeCode,
      },
      reviewer: r.reviewer
        ? {
            id: r.reviewer.id,
            name:
              r.reviewer.employeeProfile?.fullName ??
              r.reviewer.email ??
              'Admin',
          }
        : null,
      status: r.status,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      serviceCount: r.services.filter((s) => s.isActive).length,
      photoCount: r.media.length,
      missingCount: completenessOf(r).length,
    };
  }
}

type ParsedServiceRow = ReplaceOnboardingServicesInput['services'][number];

/** Collapses rows with the same name+gender key. Identical prices merge silently; differing
 * prices keep the first row but mark its price uncertain and unconfirmed for a human to check. */
export function mergeServiceRows(rows: ParsedServiceRow[]): ParsedServiceRow[] {
  const byKey = new Map<string, ParsedServiceRow>();
  for (const row of rows) {
    const key = onboardingServiceKey(row.serviceName, row.applicableGender);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...row });
      continue;
    }
    const merged: ParsedServiceRow = {
      ...prev,
      durationMinutes: prev.durationMinutes ?? row.durationMinutes,
      category: prev.category ?? row.category,
      description: prev.description ?? row.description,
    };
    if (prev.basePrice == null) merged.basePrice = row.basePrice;
    else if (row.basePrice != null && row.basePrice !== prev.basePrice) {
      merged.confirmedByEmployee = false;
      merged.uncertainFields = Array.from(
        new Set([...(prev.uncertainFields ?? []), 'basePrice']),
      );
    }
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}
