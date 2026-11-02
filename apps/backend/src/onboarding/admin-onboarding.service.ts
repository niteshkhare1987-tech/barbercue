import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, Role, type OnboardingStatus } from '@prisma/client';
import {
  ONBOARDING_REVIEWABLE,
  OnboardingErrorCode,
  type AdminOnboardingApplicationDto,
  type AdminOnboardingKpisDto,
  type AdminOnboardingListDto,
  type AdminOnboardingListQuery,
  type AuthenticatedUser,
  type OnboardingCorrectionInput,
  type OnboardingDuplicateDto,
  type OnboardingRejectInput,
  type OnboardingRequestChangesInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { maskPhone } from '../admin/admin-monitoring.service';
import {
  ADMIN_APPLICATION_INCLUDE,
  APPLICATION_INCLUDE,
  completenessOf,
  toAdminApplicationDto,
} from './onboarding.mapper';
import {
  OnboardingService,
  draftToData,
  onboardingNotFound,
  writeStatusHistory,
} from './onboarding.service';
import { assertOnboardingTransition } from './onboarding-transitions';
import { OnboardingNotifierService } from './onboarding-notifier.service';
import { OnboardingDuplicatesService } from './onboarding-duplicates.service';

/** May read the queue and applications. */
export const ONBOARDING_VIEW_ROLES: Role[] = [
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
];
/** May review, decide, correct, invite and publish. */
export const ONBOARDING_DECIDE_ROLES: Role[] = [
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
];

export function canDecideOnboarding(
  user: Pick<AuthenticatedUser, 'roles'>,
): boolean {
  return user.roles.some((r) => ONBOARDING_DECIDE_ROLES.includes(r));
}

/** Read-only viewers see masked owner contact details. */
export function maskOnboardingPii(
  user: Pick<AuthenticatedUser, 'roles'>,
): boolean {
  return !user.roles.some(
    (r) =>
      r === Role.PLATFORM_ADMIN ||
      r === Role.CO_FOUNDER ||
      r === Role.SALES_ADMIN,
  );
}

const IST_OFFSET_MS = 330 * 60_000;
function istDayStart(date: string): Date {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
}

@Injectable()
export class AdminOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
    private readonly notifier: OnboardingNotifierService,
    private readonly duplicates: OnboardingDuplicatesService,
  ) {}

  // ---------- Queue ----------

  async list(
    user: AuthenticatedUser,
    query: AdminOnboardingListQuery,
  ): Promise<AdminOnboardingListDto> {
    const where = this.listWhere(query);
    const mask = maskOnboardingPii(user);
    const needsMissingFilter = query.missingInfo !== undefined;
    // "Missing information" is computed, not stored, so that filter pages in memory (capped).
    const paging: { skip?: number; take: number } = needsMissingFilter
      ? { take: 2000 }
      : { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
    const rows = await this.prisma.salonOnboardingApplication.findMany({
      where,
      include: APPLICATION_INCLUDE,
      orderBy: [
        { submittedAt: { sort: 'asc', nulls: 'last' } },
        { updatedAt: 'desc' },
      ],
      ...paging,
    });
    let items = rows.map((r) =>
      this.onboarding.toListItem(r, mask ? maskPhone : undefined),
    );
    let total: number;
    if (needsMissingFilter) {
      const wantMissing = query.missingInfo === 'true';
      items = items.filter((i) => i.missingCount > 0 === wantMissing);
      total = items.length;
      items = items.slice(
        (query.page - 1) * query.pageSize,
        query.page * query.pageSize,
      );
    } else {
      total = await this.prisma.salonOnboardingApplication.count({ where });
    }
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  private listWhere(
    query: AdminOnboardingListQuery,
  ): Prisma.SalonOnboardingApplicationWhereInput {
    const and: Prisma.SalonOnboardingApplicationWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.city)
      and.push({ city: { equals: query.city, mode: 'insensitive' } });
    if (query.territory)
      and.push({ territory: { equals: query.territory, mode: 'insensitive' } });
    if (query.employeeId) and.push({ assignedEmployeeId: query.employeeId });
    if (query.reviewerId) and.push({ reviewerId: query.reviewerId });
    if (query.from) and.push({ submittedAt: { gte: istDayStart(query.from) } });
    if (query.to) {
      and.push({
        submittedAt: {
          lt: new Date(istDayStart(query.to).getTime() + 86_400_000),
        },
      });
    }
    if (query.q) {
      const q = query.q;
      and.push({
        OR: [
          { reference: { contains: q, mode: 'insensitive' } },
          { salonName: { contains: q, mode: 'insensitive' } },
          { ownerName: { contains: q, mode: 'insensitive' } },
          { ownerPhone: { contains: q.replace(/\s/g, '') } },
          { locality: { contains: q, mode: 'insensitive' } },
        ],
      });
    }
    return and.length ? { AND: and } : {};
  }

  async kpis(): Promise<AdminOnboardingKpisDto> {
    const [grouped, reviewed, stale, byEmployeeRaw, byCityRaw] =
      await Promise.all([
        this.prisma.salonOnboardingApplication.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        this.prisma.salonOnboardingApplication.findMany({
          where: {
            firstSubmittedAt: { not: null },
            OR: [{ approvedAt: { not: null } }, { rejectedAt: { not: null } }],
          },
          select: {
            firstSubmittedAt: true,
            approvedAt: true,
            rejectedAt: true,
          },
        }),
        this.prisma.salonOnboardingApplication.count({
          where: {
            status: { in: [...ONBOARDING_REVIEWABLE] },
            submittedAt: { lt: new Date(Date.now() - 48 * 3_600_000) },
          },
        }),
        this.prisma.salonOnboardingApplication.groupBy({
          by: ['assignedEmployeeId', 'status'],
          _count: { _all: true },
        }),
        this.prisma.salonOnboardingApplication.groupBy({
          by: ['city', 'status'],
          _count: { _all: true },
        }),
      ]);
    const count = (...statuses: OnboardingStatus[]) =>
      grouped
        .filter((g) => statuses.includes(g.status))
        .reduce((s, g) => s + g._count._all, 0);
    const approvedSet: OnboardingStatus[] = [
      'APPROVED',
      'OWNER_INVITED',
      'AWAITING_OWNER_ACTIVATION',
      'READY_TO_PUBLISH',
      'ACTIVE',
      'SUSPENDED',
    ];
    const durations = reviewed
      .map((r) => {
        const end = r.approvedAt ?? r.rejectedAt;
        return end && r.firstSubmittedAt
          ? end.getTime() - r.firstSubmittedAt.getTime()
          : null;
      })
      .filter((d): d is number => d !== null);

    const employees = await this.prisma.employeeProfile.findMany({
      where: {
        id: {
          in: [...new Set(byEmployeeRaw.map((r) => r.assignedEmployeeId))],
        },
      },
      select: { id: true, fullName: true, employeeCode: true },
    });
    const byEmployee = employees
      .map((e) => {
        const rows = byEmployeeRaw.filter((r) => r.assignedEmployeeId === e.id);
        return {
          employeeId: e.id,
          fullName: e.fullName,
          employeeCode: e.employeeCode,
          total: rows.reduce((s, r) => s + r._count._all, 0),
          approved: rows
            .filter((r) => approvedSet.includes(r.status))
            .reduce((s, r) => s + r._count._all, 0),
        };
      })
      .sort((a, b) => b.total - a.total);
    const cityMap = new Map<
      string,
      { city: string; total: number; approved: number }
    >();
    for (const r of byCityRaw) {
      const city = r.city?.trim() || 'Not entered';
      const entry = cityMap.get(city.toLowerCase()) ?? {
        city,
        total: 0,
        approved: 0,
      };
      entry.total += r._count._all;
      if (approvedSet.includes(r.status)) entry.approved += r._count._all;
      cityMap.set(city.toLowerCase(), entry);
    }

    return {
      total: grouped.reduce((s, g) => s + g._count._all, 0),
      drafts: count('DRAFT'),
      pendingReview: count('SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'),
      changesRequested: count('CHANGES_REQUESTED'),
      approved: count(...approvedSet),
      rejected: count('REJECTED'),
      awaitingOwnerActivation: count(
        'APPROVED',
        'OWNER_INVITED',
        'AWAITING_OWNER_ACTIVATION',
      ),
      activeSalons: count('ACTIVE'),
      averageReviewHours: durations.length
        ? Math.round(
            (durations.reduce((s, d) => s + d, 0) /
              durations.length /
              3_600_000) *
              10,
          ) / 10
        : null,
      pendingOver48Hours: stale,
      byEmployee,
      byCity: [...cityMap.values()].sort((a, b) => b.total - a.total),
    };
  }

  // ---------- Detail ----------

  async get(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AdminOnboardingApplicationDto> {
    const app = await this.prisma.salonOnboardingApplication.findUnique({
      where: { id },
      include: ADMIN_APPLICATION_INCLUDE,
    });
    if (!app) throw onboardingNotFound();
    return toAdminApplicationDto(app, {
      maskPii: maskOnboardingPii(user),
      canDecide: canDecideOnboarding(user) && !this.isSubmitter(user.id, app),
    });
  }

  async duplicatesFor(id: string): Promise<OnboardingDuplicateDto[]> {
    const app = await this.prisma.salonOnboardingApplication.findUnique({
      where: { id },
    });
    if (!app) throw onboardingNotFound();
    return this.duplicates.find(app);
  }

  // ---------- Review actions ----------

  async startReview(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AdminOnboardingApplicationDto> {
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockForDecision(tx, user, id);
      const next = assertOnboardingTransition(
        'START_REVIEW',
        app.status,
        'ADMIN',
      );
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: {
          status: next,
          reviewStartedAt: app.reviewStartedAt ?? new Date(),
          reviewerId: app.reviewerId ?? user.id,
        },
      });
      await writeStatusHistory(
        tx,
        id,
        app.status,
        next,
        user.id,
        'Review started',
      );
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'START_REVIEW',
          applicationVersion: app.version,
        },
      });
    });
    return this.get(user, id);
  }

  async assignReviewer(
    user: AuthenticatedUser,
    id: string,
    reviewerId: string | null,
  ): Promise<AdminOnboardingApplicationDto> {
    if (reviewerId) {
      const ok = await this.prisma.userRole.findFirst({
        where: {
          userId: reviewerId,
          salonId: null,
          role: { in: ONBOARDING_DECIDE_ROLES },
        },
      });
      if (!ok) {
        throw new AppException(
          OnboardingErrorCode.INVALID_TRANSITION,
          'The reviewer must be a FastQue admin who can make onboarding decisions.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockForDecision(tx, user, id);
      if (reviewerId && this.isSubmitter(reviewerId, app)) {
        throw new AppException(
          OnboardingErrorCode.SELF_REVIEW_FORBIDDEN,
          'The employee who submitted an application cannot review it.',
          HttpStatus.FORBIDDEN,
        );
      }
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { reviewerId },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: reviewerId ? 'Reviewer assigned' : 'Reviewer unassigned',
          details: { reviewerId },
          applicationVersion: app.version,
        },
      });
    });
    return this.get(user, id);
  }

  async saveNotes(
    user: AuthenticatedUser,
    id: string,
    internalNotes: string,
  ): Promise<AdminOnboardingApplicationDto> {
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockForDecision(tx, user, id);
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { internalNotes: internalNotes || null },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: 'Internal notes updated',
          applicationVersion: app.version,
        },
      });
    });
    return this.get(user, id);
  }

  /** Admin field corrections, each recorded with before/after values in the review trail. */
  async correct(
    user: AuthenticatedUser,
    id: string,
    input: OnboardingCorrectionInput,
  ): Promise<AdminOnboardingApplicationDto> {
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockForDecision(tx, user, id);
      this.assertVersion(app.version, input.applicationVersion);
      if (!ONBOARDING_REVIEWABLE.includes(app.status)) {
        throw new AppException(
          OnboardingErrorCode.INVALID_TRANSITION,
          'Only applications awaiting review can be corrected.',
          HttpStatus.CONFLICT,
        );
      }
      const data = draftToData(input.changes);
      const before = app as unknown as Record<string, unknown>;
      const diff = Object.entries(data)
        .filter(
          ([k, v]) =>
            k !== 'version' &&
            JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null),
        )
        .map(([field, to]) => ({
          field,
          from: before[field] ?? null,
          to: to ?? null,
        }));
      if (!diff.length) return;
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'CORRECTION',
          comments: input.reason,
          details: diff as unknown as Prisma.InputJsonValue,
          applicationVersion: app.version + 1,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'ONBOARDING_FIELDS_CORRECTED',
          entityType: 'SalonOnboardingApplication',
          entityId: id,
          metadata: { fields: diff.map((d) => d.field), reason: input.reason },
        },
      });
    });
    return this.get(user, id);
  }

  async setPhotoException(
    user: AuthenticatedUser,
    id: string,
    reason: string | null,
  ): Promise<AdminOnboardingApplicationDto> {
    await this.prisma.$transaction(async (tx) => {
      const app = await this.lockForDecision(tx, user, id);
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: {
          photoExceptionReason: reason,
          photoExceptionById: reason ? user.id : null,
        },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'NOTE',
          comments: reason
            ? `Photo requirement waived: ${reason}`
            : 'Photo exception removed',
          applicationVersion: app.version,
        },
      });
    });
    return this.get(user, id);
  }

  async requestChanges(
    user: AuthenticatedUser,
    id: string,
    input: OnboardingRequestChangesInput,
  ): Promise<AdminOnboardingApplicationDto> {
    const app = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockForDecision(tx, user, id);
      this.assertVersion(current.version, input.applicationVersion);
      const next = assertOnboardingTransition(
        'REQUEST_CHANGES',
        current.status,
        'ADMIN',
      );
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: { status: next, changeRequest: input.items },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'REQUEST_CHANGES',
          comments: input.comments ?? null,
          details: input.items,
          applicationVersion: current.version,
        },
      });
      await writeStatusHistory(
        tx,
        id,
        current.status,
        next,
        user.id,
        input.items
          .map((i) => `${i.field}: ${i.message}`)
          .join('; ')
          .slice(0, 1000),
      );
      return current;
    });
    await this.notifier.toEmployee(
      app.assignedEmployeeId,
      'onboarding.changes_requested',
      id,
      {
        reference: app.reference,
        salonName: app.salonName,
        items: input.items,
      },
    );
    return this.get(user, id);
  }

  async reject(
    user: AuthenticatedUser,
    id: string,
    input: OnboardingRejectInput,
  ): Promise<AdminOnboardingApplicationDto> {
    const app = await this.prisma.$transaction(async (tx) => {
      const current = await this.lockForDecision(tx, user, id);
      this.assertVersion(current.version, input.applicationVersion);
      const next = assertOnboardingTransition(
        'REJECT',
        current.status,
        'ADMIN',
      );
      await tx.salonOnboardingApplication.update({
        where: { id },
        data: {
          status: next,
          rejectedAt: new Date(),
          rejectionReason: input.reason,
        },
      });
      await tx.salonOnboardingReview.create({
        data: {
          applicationId: id,
          reviewerId: user.id,
          decision: 'REJECT',
          comments: input.reason,
          applicationVersion: current.version,
        },
      });
      await writeStatusHistory(
        tx,
        id,
        current.status,
        next,
        user.id,
        input.reason,
      );
      return current;
    });
    await this.notifier.toEmployee(
      app.assignedEmployeeId,
      'onboarding.rejected',
      id,
      {
        reference: app.reference,
        salonName: app.salonName,
        reason: input.reason,
      },
    );
    return this.get(user, id);
  }

  // ---------- Guards ----------

  /** Row lock + decision-role + "never your own application" checks shared by every action. */
  async lockForDecision(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    id: string,
  ) {
    if (!canDecideOnboarding(user)) {
      throw new AppException(
        OnboardingErrorCode.INVALID_TRANSITION,
        'You can view onboarding applications but not change them.',
        HttpStatus.FORBIDDEN,
      );
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM salon_onboarding_applications WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw onboardingNotFound();
    const app = await tx.salonOnboardingApplication.findUniqueOrThrow({
      where: { id },
      include: { assignedEmployee: { select: { userId: true } } },
    });
    if (this.isSubmitter(user.id, app)) {
      throw new AppException(
        OnboardingErrorCode.SELF_REVIEW_FORBIDDEN,
        'You cannot review or approve an application you submitted.',
        HttpStatus.FORBIDDEN,
      );
    }
    return app;
  }

  isSubmitter(
    userId: string,
    app: { createdByUserId: string; assignedEmployee: { userId: string } },
  ): boolean {
    return (
      app.createdByUserId === userId || app.assignedEmployee.userId === userId
    );
  }

  assertVersion(current: number, submitted: number): void {
    if (current !== submitted) {
      throw new AppException(
        OnboardingErrorCode.VERSION_CONFLICT,
        'The application changed since you opened it. Reload and review the latest version.',
        HttpStatus.CONFLICT,
        { currentVersion: current },
      );
    }
  }

  /** Used by approval: the application must have no missing information at decision time. */
  async assertComplete(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    const app = await tx.salonOnboardingApplication.findUniqueOrThrow({
      where: { id },
      include: APPLICATION_INCLUDE,
    });
    const missing = completenessOf(app);
    if (missing.length) {
      throw new AppException(
        OnboardingErrorCode.INCOMPLETE,
        'This application is missing required information. Request changes instead.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { missing },
      );
    }
  }
}
