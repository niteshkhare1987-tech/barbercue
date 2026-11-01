import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ADMIN_ADOPTION_THRESHOLDS,
  BookingStatus,
  QueueEntrySource,
  QueueEntryStatus,
  SalonStatus,
  decimalStringToPaise,
  type AdminAdoptionCategory,
  type AdminAnalyticsRangeQuery,
  type AdminExecutiveOverviewDto,
  type AdminKpiValue,
  type AdminServedCustomersDto,
} from '@barbercue/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  addZonedCalendarDays,
  utcToZonedDateStr,
} from '../../common/timezone/timezone';
import { localRange } from '../../owner-ops/local-time';
import { ADMIN_SHOP_ACTIVITY_TIME_ZONE } from '../admin-shop-activity.service';
import { maskPhone } from '../admin-monitoring.service';
import {
  ADOPTION_CATEGORIES,
  averagePaise,
  cancellationRate,
  classifyAdoption,
  noShowRate,
  previousRange,
} from './executive-metrics';

const TZ = ADMIN_SHOP_ACTIVITY_TIME_ZONE;
const SHOPS_LIMIT = 100;
const SERVED_CUSTOMERS_LIMIT = 50_000;

/**
 * CTE `served`: one row per completed visit ever (completed appointments + served walk-ins),
 * keyed to a customer — their account, else the account that owns the visit's phone, else the
 * phone itself (last 10 digits). `key` is NULL when a visit has neither account nor phone.
 */
const SERVED_VISITS_CTE = Prisma.sql`
  account_phones AS (
    SELECT DISTINCT ON (p) p, "id"
      FROM (SELECT right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) AS p, "id", "createdAt"
              FROM "users" WHERE "phone" IS NOT NULL) u
     ORDER BY p, "createdAt"
  ),
  visits AS (
    SELECT b."salonId", b."slotStart" AS "servedAt", b."customerId", 'APPOINTMENT' AS kind,
           regexp_replace(COALESCE(b."guestPhone", ''), '[^0-9]', '', 'g') AS digits
      FROM "bookings" b
     WHERE b."status" = 'COMPLETED'
    UNION ALL
    SELECT q."salonId", q."joinedAt", q."customerId", 'WALK_IN',
           regexp_replace(COALESCE(q."contactPhone", ''), '[^0-9]', '', 'g')
      FROM "queue_entries" q
     WHERE q."source" = 'WALK_IN' AND q."status" = 'COMPLETED'
  ),
  served AS (
    SELECT v."salonId", v."servedAt", v.kind,
           CASE WHEN length(v.digits) >= 10 THEN right(v.digits, 10) END AS phone,
           COALESCE(v."customerId", ap."id",
                    CASE WHEN length(v.digits) >= 10 THEN 'phone:' || right(v.digits, 10) END) AS key
      FROM visits v
      LEFT JOIN account_phones ap
        ON v."customerId" IS NULL AND length(v.digits) >= 10 AND ap.p = right(v.digits, 10)
  )`;

interface ShopPeriod {
  appointmentsCompleted: number;
  cancelled: number;
  noShow: number;
  walkInsServed: number;
  appointmentValuePaise: number;
  walkInValuePaise: number;
}

interface PeriodAggregates {
  perShop: Map<string, ShopPeriod>;
  appointmentsBooked: number;
  registeredSalons: number;
  newSalons: number;
  completedServiceMinutes: number;
  /** Visits whose value is known (appointments always; walk-ins only when a service was chosen). */
  valuedVisits: number;
}

const emptyShop = (): ShopPeriod => ({
  appointmentsCompleted: 0,
  cancelled: 0,
  noShow: 0,
  walkInsServed: 0,
  appointmentValuePaise: 0,
  walkInValuePaise: 0,
});

function window(from: string, toInclusive: string): { start: Date; end: Date } {
  const range = localRange(from, addZonedCalendarDays(toInclusive, 1), TZ);
  // Unreachable with a fixed zone and schema-validated dates.
  if (!range) throw new Error('Could not resolve the IST date range');
  return range;
}

const kpi = (
  current: number | null,
  previous: number | null,
): AdminKpiValue => ({
  current,
  previous,
});

/**
 * Executive Command Center read model. Read-only, count/sum only, no customer PII.
 * Every number follows docs/admin-dashboard-2.0/PLAN.md §4 via ./executive-metrics.
 */
@Injectable()
export class AdminExecutiveOverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(
    query: AdminAnalyticsRangeQuery,
    now: Date = new Date(),
  ): Promise<AdminExecutiveOverviewDto> {
    const prev = previousRange(query.from, query.to, addZonedCalendarDays);
    const current = window(query.from, query.to);
    const previous = window(prev.from, prev.to);

    const [cur, old, trend, adoption, customersServed, salons] =
      await Promise.all([
        this.periodAggregates(current.start, current.end),
        this.periodAggregates(previous.start, previous.end),
        this.dailyTrend(current.start, current.end),
        this.adoption(current.end < now ? current.end : now),
        this.customersServedTotals(),
        this.prisma.salon.findMany({
          select: {
            id: true,
            publicId: true,
            name: true,
            status: true,
            createdAt: true,
            city: { select: { name: true } },
          },
        }),
      ]);

    const totals = (p: PeriodAggregates) => {
      let appointmentsCompleted = 0;
      let cancelled = 0;
      let noShow = 0;
      let walkInsServed = 0;
      let value = 0;
      let walkInValue = 0;
      let serving = 0;
      for (const s of p.perShop.values()) {
        appointmentsCompleted += s.appointmentsCompleted;
        cancelled += s.cancelled;
        noShow += s.noShow;
        walkInsServed += s.walkInsServed;
        value += s.appointmentValuePaise + s.walkInValuePaise;
        walkInValue += s.walkInValuePaise;
        if (s.appointmentsCompleted + s.walkInsServed > 0) serving += 1;
      }
      const outcomes = { completed: appointmentsCompleted, cancelled, noShow };
      return {
        appointmentsCompleted,
        cancelled,
        noShow,
        walkInsServed,
        visits: appointmentsCompleted + walkInsServed,
        value,
        walkInValue,
        serving,
        cancellationRate: cancellationRate(outcomes),
        noShowRate: noShowRate(outcomes),
        average: averagePaise(value, p.valuedVisits),
      };
    };
    const c = totals(cur);
    const o = totals(old);

    const shopRows = salons
      .filter((s) => cur.perShop.has(s.id))
      .map((s) => {
        const p = cur.perShop.get(s.id)!;
        return {
          id: s.id,
          publicId: s.publicId,
          name: s.name,
          city: s.city.name,
          status: s.status,
          registeredAt: s.createdAt.toISOString(),
          adoption: adoption.bySalon.get(s.id) ?? 'NEVER_ACTIVATED',
          completedVisits: p.appointmentsCompleted + p.walkInsServed,
          appointmentsCompleted: p.appointmentsCompleted,
          walkInsServed: p.walkInsServed,
          cancelled: p.cancelled,
          noShow: p.noShow,
          serviceValuePaise: p.appointmentValuePaise + p.walkInValuePaise,
        };
      })
      .sort(
        (a, b) =>
          b.completedVisits - a.completedVisits ||
          b.serviceValuePaise - a.serviceValuePaise ||
          a.name.localeCompare(b.name),
      );

    return {
      from: query.from,
      to: query.to,
      previousFrom: prev.from,
      previousTo: prev.to,
      timeZone: TZ,
      generatedAt: now.toISOString(),
      kpis: {
        registeredSalons: kpi(cur.registeredSalons, old.registeredSalons),
        newSalons: kpi(cur.newSalons, old.newSalons),
        servingSalons: kpi(c.serving, o.serving),
        appointmentsBooked: kpi(cur.appointmentsBooked, old.appointmentsBooked),
        appointmentsCompleted: kpi(
          c.appointmentsCompleted,
          o.appointmentsCompleted,
        ),
        walkInsServed: kpi(c.walkInsServed, o.walkInsServed),
        completedVisits: kpi(c.visits, o.visits),
        cancelled: kpi(c.cancelled, o.cancelled),
        noShow: kpi(c.noShow, o.noShow),
        cancellationRatePercent: kpi(c.cancellationRate, o.cancellationRate),
        noShowRatePercent: kpi(c.noShowRate, o.noShowRate),
        completedServiceValuePaise: kpi(c.value, o.value),
        walkInValueEstimatePaise: kpi(c.walkInValue, o.walkInValue),
        averageVisitValuePaise: kpi(c.average, o.average),
        completedServiceMinutes: kpi(
          cur.completedServiceMinutes,
          old.completedServiceMinutes,
        ),
        openSalonsNow: salons.filter((s) => s.status === SalonStatus.ACTIVE)
          .length,
        platformRevenuePaise: null,
      },
      trend: this.fillTrend(query.from, query.to, trend),
      adoption: {
        asOf: adoption.asOf,
        windowDays: ADMIN_ADOPTION_THRESHOLDS.windowDays,
        totalSalons: salons.length,
        counts: adoption.counts,
      },
      shops: shopRows.slice(0, SHOPS_LIMIT),
      shopsTotal: shopRows.length,
      shopsLimit: SHOPS_LIMIT,
      customersServed,
    };
  }

  /** Every unique customer ever served, most recent first. Phones are masked. */
  async getServedCustomers(
    now: Date = new Date(),
  ): Promise<AdminServedCustomersDto> {
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<
        {
          key: string;
          accountPhone: string | null;
          visitPhone: string | null;
          firstServedAt: Date;
          lastServedAt: Date;
          visits: number;
          appointments: number;
          walkIns: number;
          salons: number;
          lastSalon: string;
        }[]
      >`
        WITH ${SERVED_VISITS_CTE}
        SELECT s.key,
               u."phone" AS "accountPhone",
               MAX(s.phone) AS "visitPhone",
               MIN(s."servedAt") AS "firstServedAt",
               MAX(s."servedAt") AS "lastServedAt",
               COUNT(*)::int AS visits,
               COUNT(*) FILTER (WHERE s.kind = 'APPOINTMENT')::int AS appointments,
               COUNT(*) FILTER (WHERE s.kind = 'WALK_IN')::int AS "walkIns",
               COUNT(DISTINCT s."salonId")::int AS salons,
               (array_agg(sa."name" ORDER BY s."servedAt" DESC))[1] AS "lastSalon"
          FROM served s
          JOIN "salons" sa ON sa."id" = s."salonId"
          LEFT JOIN "users" u ON u."id" = s.key
         WHERE s.key IS NOT NULL
         GROUP BY s.key, u."phone"
         ORDER BY MAX(s."servedAt") DESC, s.key
         LIMIT ${SERVED_CUSTOMERS_LIMIT}`,
      this.customersServedTotals(),
    ]);

    return {
      generatedAt: now.toISOString(),
      timeZone: TZ,
      total: totals.unique,
      limit: SERVED_CUSTOMERS_LIMIT,
      unidentifiedVisits: totals.unidentifiedVisits,
      customers: rows.map((r) => {
        const registered = !r.key.startsWith('phone:');
        return {
          type: registered ? 'REGISTERED' : 'GUEST',
          maskedPhone: maskPhone(r.accountPhone ?? r.visitPhone),
          firstServedOn: utcToZonedDateStr(r.firstServedAt, TZ),
          lastServedOn: utcToZonedDateStr(r.lastServedAt, TZ),
          completedVisits: r.visits,
          appointmentsCompleted: r.appointments,
          walkInsServed: r.walkIns,
          salonsVisited: r.salons,
          lastSalon: r.lastSalon,
        };
      }),
    };
  }

  private async customersServedTotals(): Promise<
    AdminExecutiveOverviewDto['customersServed']
  > {
    const rows = await this.prisma.$queryRaw<
      { uniqueCustomers: number; unidentifiedVisits: number }[]
    >`
      WITH ${SERVED_VISITS_CTE}
      SELECT COUNT(DISTINCT key)::int AS "uniqueCustomers",
             COUNT(*) FILTER (WHERE key IS NULL)::int AS "unidentifiedVisits"
        FROM served`;
    return {
      unique: rows[0]?.uniqueCustomers ?? 0,
      unidentifiedVisits: rows[0]?.unidentifiedVisits ?? 0,
    };
  }

  private async periodAggregates(
    start: Date,
    end: Date,
  ): Promise<PeriodAggregates> {
    const [
      outcomeGroups,
      walkInGroups,
      appointmentValues,
      walkInValues,
      appointmentsBooked,
      registeredSalons,
      newSalons,
      minutesRows,
    ] = await Promise.all([
      this.prisma.booking.groupBy({
        by: ['salonId', 'status'],
        where: {
          slotStart: { gte: start, lt: end },
          status: {
            in: [
              BookingStatus.COMPLETED,
              BookingStatus.CANCELLED,
              BookingStatus.NO_SHOW,
            ],
          },
        },
        _count: { _all: true },
      }),
      this.prisma.queueEntry.groupBy({
        by: ['salonId'],
        where: {
          source: QueueEntrySource.WALK_IN,
          status: QueueEntryStatus.COMPLETED,
          joinedAt: { gte: start, lt: end },
        },
        _count: { _all: true },
      }),
      // Price snapshot of the booked services (legacy single-service bookings fall back to the
      // linked service, exactly like resolveEffectiveBookingServices), minus the online discount.
      this.prisma.$queryRaw<
        { salonId: string; total: Prisma.Decimal | null }[]
      >`
        SELECT b."salonId" AS "salonId",
               SUM(COALESCE(items.total, sv."price") - b."onlineBookingDiscountAmount") AS total
          FROM "bookings" b
          JOIN "services" sv ON sv."id" = b."serviceId"
          LEFT JOIN (
            SELECT "bookingId", SUM("price") AS total FROM "booking_services" GROUP BY "bookingId"
          ) items ON items."bookingId" = b."id"
         WHERE b."status" = 'COMPLETED' AND b."slotStart" >= ${start} AND b."slotStart" < ${end}
         GROUP BY 1`,
      // Walk-ins have no price snapshot: current menu price of the chosen service (an estimate).
      this.prisma.$queryRaw<
        { salonId: string; total: Prisma.Decimal | null; valued: number }[]
      >`
        SELECT q."salonId" AS "salonId", SUM(sv."price") AS total, COUNT(sv."id")::int AS valued
          FROM "queue_entries" q
          JOIN "services" sv ON sv."id" = q."serviceId"
         WHERE q."source" = 'WALK_IN' AND q."status" = 'COMPLETED'
           AND q."joinedAt" >= ${start} AND q."joinedAt" < ${end}
         GROUP BY 1`,
      this.prisma.booking.count({
        where: { createdAt: { gte: start, lt: end } },
      }),
      this.prisma.salon.count({ where: { createdAt: { lt: end } } }),
      this.prisma.salon.count({
        where: { createdAt: { gte: start, lt: end } },
      }),
      this.prisma.$queryRaw<{ minutes: number | null }[]>`
        SELECT ROUND(SUM(EXTRACT(EPOCH FROM ("endedAt" - "startedAt")) / 60))::int AS minutes
          FROM "service_sessions"
         WHERE "status" = 'COMPLETED' AND "endedAt" >= ${start} AND "endedAt" < ${end}`,
    ]);

    const perShop = new Map<string, ShopPeriod>();
    const shop = (id: string) => {
      let row = perShop.get(id);
      if (!row) {
        row = emptyShop();
        perShop.set(id, row);
      }
      return row;
    };
    for (const g of outcomeGroups) {
      const row = shop(g.salonId);
      if (g.status === BookingStatus.COMPLETED)
        row.appointmentsCompleted += g._count._all;
      else if (g.status === BookingStatus.CANCELLED)
        row.cancelled += g._count._all;
      else if (g.status === BookingStatus.NO_SHOW) row.noShow += g._count._all;
    }
    for (const g of walkInGroups)
      shop(g.salonId).walkInsServed += g._count._all;
    for (const r of appointmentValues) {
      shop(r.salonId).appointmentValuePaise += decimalStringToPaise(
        (r.total ?? 0).toString(),
      );
    }
    let valuedWalkIns = 0;
    for (const r of walkInValues) {
      shop(r.salonId).walkInValuePaise += decimalStringToPaise(
        (r.total ?? 0).toString(),
      );
      valuedWalkIns += r.valued;
    }
    let completedAppointments = 0;
    for (const row of perShop.values())
      completedAppointments += row.appointmentsCompleted;

    return {
      perShop,
      appointmentsBooked,
      registeredSalons,
      newSalons,
      completedServiceMinutes: minutesRows[0]?.minutes ?? 0,
      valuedVisits: completedAppointments + valuedWalkIns,
    };
  }

  private async dailyTrend(start: Date, end: Date) {
    const [appointments, walkIns] = await Promise.all([
      this.prisma.$queryRaw<
        { day: string; n: number; total: Prisma.Decimal | null }[]
      >`
        SELECT to_char((b."slotStart" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}::text, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS n,
               SUM(COALESCE(items.total, sv."price") - b."onlineBookingDiscountAmount") AS total
          FROM "bookings" b
          JOIN "services" sv ON sv."id" = b."serviceId"
          LEFT JOIN (
            SELECT "bookingId", SUM("price") AS total FROM "booking_services" GROUP BY "bookingId"
          ) items ON items."bookingId" = b."id"
         WHERE b."status" = 'COMPLETED' AND b."slotStart" >= ${start} AND b."slotStart" < ${end}
         GROUP BY 1`,
      this.prisma.$queryRaw<
        { day: string; n: number; total: Prisma.Decimal | null }[]
      >`
        SELECT to_char((q."joinedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}::text, 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS n,
               SUM(sv."price") AS total
          FROM "queue_entries" q
          LEFT JOIN "services" sv ON sv."id" = q."serviceId"
         WHERE q."source" = 'WALK_IN' AND q."status" = 'COMPLETED'
           AND q."joinedAt" >= ${start} AND q."joinedAt" < ${end}
         GROUP BY 1`,
    ]);
    return { appointments, walkIns };
  }

  private fillTrend(
    from: string,
    to: string,
    rows: Awaited<ReturnType<AdminExecutiveOverviewService['dailyTrend']>>,
  ): AdminExecutiveOverviewDto['trend'] {
    const days = new Map<string, AdminExecutiveOverviewDto['trend'][number]>();
    for (let d = from; d <= to; d = addZonedCalendarDays(d, 1)) {
      days.set(d, {
        date: d,
        appointmentsCompleted: 0,
        walkInsServed: 0,
        serviceValuePaise: 0,
      });
    }
    for (const r of rows.appointments) {
      const day = days.get(r.day);
      if (!day) continue;
      day.appointmentsCompleted += r.n;
      day.serviceValuePaise += decimalStringToPaise((r.total ?? 0).toString());
    }
    for (const r of rows.walkIns) {
      const day = days.get(r.day);
      if (!day) continue;
      day.walkInsServed += r.n;
      day.serviceValuePaise += decimalStringToPaise((r.total ?? 0).toString());
    }
    return [...days.values()];
  }

  /** Adoption categories over the 30 days ending at `windowEnd` (never later than now). */
  private async adoption(windowEnd: Date) {
    const t = ADMIN_ADOPTION_THRESHOLDS;
    const windowStart = new Date(
      windowEnd.getTime() - t.windowDays * 86_400_000,
    );
    const previousStart = new Date(
      windowStart.getTime() - t.windowDays * 86_400_000,
    );

    const visits = async (start: Date | null, end: Date) => {
      const [appointments, walkIns] = await Promise.all([
        this.prisma.booking.groupBy({
          by: ['salonId'],
          where: {
            status: BookingStatus.COMPLETED,
            slotStart: start ? { gte: start, lt: end } : { lt: end },
          },
          _count: { _all: true },
        }),
        this.prisma.queueEntry.groupBy({
          by: ['salonId'],
          where: {
            source: QueueEntrySource.WALK_IN,
            status: QueueEntryStatus.COMPLETED,
            joinedAt: start ? { gte: start, lt: end } : { lt: end },
          },
          _count: { _all: true },
        }),
      ]);
      const map = new Map<string, number>();
      for (const g of [...appointments, ...walkIns]) {
        map.set(g.salonId, (map.get(g.salonId) ?? 0) + g._count._all);
      }
      return map;
    };

    const [inWindow, inPrevious, ever, salons] = await Promise.all([
      visits(windowStart, windowEnd),
      visits(previousStart, windowStart),
      visits(null, windowEnd),
      this.prisma.salon.findMany({
        where: { createdAt: { lt: windowEnd } },
        select: { id: true, createdAt: true },
      }),
    ]);

    const counts = Object.fromEntries(
      ADOPTION_CATEGORIES.map((c) => [c, 0]),
    ) as Record<AdminAdoptionCategory, number>;
    const bySalon = new Map<string, AdminAdoptionCategory>();
    for (const salon of salons) {
      const category = classifyAdoption({
        registeredAt: salon.createdAt,
        windowEnd,
        visitsInWindow: inWindow.get(salon.id) ?? 0,
        visitsInPreviousWindow: inPrevious.get(salon.id) ?? 0,
        visitsEver: ever.get(salon.id) ?? 0,
      });
      counts[category] += 1;
      bySalon.set(salon.id, category);
    }
    // The last IST day the window covers (windowEnd is exclusive).
    const asOf = utcToZonedDateStr(new Date(windowEnd.getTime() - 1), TZ);
    return { counts, bySalon, asOf };
  }
}
