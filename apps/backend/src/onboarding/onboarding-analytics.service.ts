import { Injectable } from '@nestjs/common';
import type {
  AdminOnboardingAnalyticsDto,
  OnboardingFunnelDto,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';

interface AppFacts {
  id: string;
  assignedEmployeeId: string;
  status: string;
  salonId: string | null;
  firstSubmittedAt: Date | null;
  approvedAt: Date | null;
  publishedAt: Date | null;
}

const DAY_MS = 86_400_000;
const avgDays = (values: number[]): number | null =>
  values.length
    ? Math.round(
        (values.reduce((s, v) => s + v, 0) / values.length / DAY_MS) * 10,
      ) / 10
    : null;

/**
 * Field-team onboarding funnel. The definitions are deliberately separate and never collapsed:
 * lead created -> application submitted -> admin approved -> owner activated -> publicly active
 * -> receiving bookings. An application that was never approved is never counted as onboarded.
 */
@Injectable()
export class OnboardingAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async forEmployee(employeeProfileId: string): Promise<OnboardingFunnelDto> {
    const facts = await this.collect([employeeProfileId]);
    return facts.get(employeeProfileId) ?? emptyFunnel();
  }

  async forTeam(): Promise<AdminOnboardingAnalyticsDto> {
    const employees = await this.prisma.employeeProfile.findMany({
      select: { id: true, fullName: true, employeeCode: true, territory: true },
      orderBy: { fullName: 'asc' },
    });
    const byEmployee = await this.collect(employees.map((e) => e.id));
    const rows = employees.map((e) => ({
      employeeId: e.id,
      fullName: e.fullName,
      employeeCode: e.employeeCode,
      territory: e.territory,
      ...(byEmployee.get(e.id) ?? emptyFunnel()),
    }));
    return { team: combine([...byEmployee.values()]), employees: rows };
  }

  private async collect(
    employeeIds: string[],
  ): Promise<Map<string, OnboardingFunnelDto>> {
    if (!employeeIds.length) return new Map();
    const [leads, visits, apps] = await Promise.all([
      this.prisma.employeeCrmLead.groupBy({
        by: ['employeeProfileId'],
        where: { employeeProfileId: { in: employeeIds } },
        _count: { _all: true },
      }),
      this.prisma.employeeCrmVisit.groupBy({
        by: ['employeeProfileId'],
        where: { employeeProfileId: { in: employeeIds } },
        _count: { _all: true },
      }),
      this.prisma.salonOnboardingApplication.findMany({
        where: { assignedEmployeeId: { in: employeeIds } },
        select: {
          id: true,
          assignedEmployeeId: true,
          status: true,
          salonId: true,
          firstSubmittedAt: true,
          approvedAt: true,
          publishedAt: true,
        },
      }),
    ]);
    const appIds = apps.map((a) => a.id);
    const salonIds = apps.map((a) => a.salonId).filter((s): s is string => !!s);
    const [activations, booked] = await Promise.all([
      appIds.length
        ? this.prisma.salonOnboardingStatusHistory.findMany({
            where: {
              applicationId: { in: appIds },
              newStatus: 'READY_TO_PUBLISH',
            },
            select: { applicationId: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          })
        : [],
      salonIds.length
        ? this.prisma.booking.groupBy({
            by: ['salonId'],
            where: { salonId: { in: salonIds } },
            _count: { _all: true },
          })
        : ([] as Array<{ salonId: string; _count: { _all: number } }>),
    ]);
    const activatedAt = new Map<string, Date>();
    for (const a of activations)
      if (!activatedAt.has(a.applicationId))
        activatedAt.set(a.applicationId, a.createdAt);
    const bookedSalons = new Set(
      booked.filter((b) => b._count._all > 0).map((b) => b.salonId),
    );

    const result = new Map<string, OnboardingFunnelDto>();
    for (const id of employeeIds) {
      const mine: AppFacts[] = apps.filter((a) => a.assignedEmployeeId === id);
      const submitted = mine.filter((a) => a.firstSubmittedAt);
      const approved = mine.filter((a) => a.approvedAt);
      const activated = approved.filter((a) => activatedAt.has(a.id));
      result.set(id, {
        leadsCreated:
          leads.find((l) => l.employeeProfileId === id)?._count._all ?? 0,
        visits:
          visits.find((v) => v.employeeProfileId === id)?._count._all ?? 0,
        applicationsStarted: mine.length,
        applicationsSubmitted: submitted.length,
        approved: approved.length,
        rejected: mine.filter((a) => a.status === 'REJECTED').length,
        ownerActivated: activated.length,
        publiclyActive: mine.filter(
          (a) => a.publishedAt && a.status === 'ACTIVE',
        ).length,
        receivingBookings: approved.filter(
          (a) => a.salonId && bookedSalons.has(a.salonId),
        ).length,
        pendingCorrections: mine.filter((a) => a.status === 'CHANGES_REQUESTED')
          .length,
        avgDaysSubmissionToApproval: avgDays(
          approved
            .filter((a) => a.firstSubmittedAt)
            .map(
              (a) =>
                (a.approvedAt as Date).getTime() -
                (a.firstSubmittedAt as Date).getTime(),
            ),
        ),
        avgDaysApprovalToActivation: avgDays(
          activated.map(
            (a) =>
              (activatedAt.get(a.id) as Date).getTime() -
              (a.approvedAt as Date).getTime(),
          ),
        ),
        conversionRate: submitted.length
          ? Math.round((approved.length / submitted.length) * 1000) / 10
          : null,
      });
    }
    return result;
  }
}

export function emptyFunnel(): OnboardingFunnelDto {
  return {
    leadsCreated: 0,
    visits: 0,
    applicationsStarted: 0,
    applicationsSubmitted: 0,
    approved: 0,
    rejected: 0,
    ownerActivated: 0,
    publiclyActive: 0,
    receivingBookings: 0,
    pendingCorrections: 0,
    avgDaysSubmissionToApproval: null,
    avgDaysApprovalToActivation: null,
    conversionRate: null,
  };
}

/** Team totals are sums of the same per-employee counts, so the two views always reconcile.
 * Averages are weighted by the number of contributing applications. */
function combine(rows: OnboardingFunnelDto[]): OnboardingFunnelDto {
  const total = emptyFunnel();
  const keys = [
    'leadsCreated',
    'visits',
    'applicationsStarted',
    'applicationsSubmitted',
    'approved',
    'rejected',
    'ownerActivated',
    'publiclyActive',
    'receivingBookings',
    'pendingCorrections',
  ] as const;
  for (const r of rows) for (const k of keys) total[k] += r[k];
  const weighted = (
    pick: (r: OnboardingFunnelDto) => number | null,
    weight: (r: OnboardingFunnelDto) => number,
  ) => {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const v = pick(r);
      if (v === null) continue;
      sum += v * weight(r);
      n += weight(r);
    }
    return n ? Math.round((sum / n) * 10) / 10 : null;
  };
  total.avgDaysSubmissionToApproval = weighted(
    (r) => r.avgDaysSubmissionToApproval,
    (r) => r.approved,
  );
  total.avgDaysApprovalToActivation = weighted(
    (r) => r.avgDaysApprovalToActivation,
    (r) => r.ownerActivated,
  );
  total.conversionRate = total.applicationsSubmitted
    ? Math.round((total.approved / total.applicationsSubmitted) * 1000) / 10
    : null;
  return total;
}
