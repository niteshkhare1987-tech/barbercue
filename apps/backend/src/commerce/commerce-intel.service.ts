import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import {
  Role,
  forecastDemand,
  paise,
  rupeesOf,
  type CommerceListQuery,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { priceNow } from './commerce-catalog.service';
import { CommerceOutboxService } from './commerce-outbox.service';
import {
  FASTQUE_SELLER_CODE,
  flag,
  indiaToday,
  money,
} from './commerce-support';

const WEEKS = 8;
const DAY = 86400_000;
const n = (v: bigint | number | null) => Number(v ?? 0);
const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : null);

/**
 * Forecasts, suggestions and reports. Everything is a statistic over real orders with its basis shown;
 * nothing here changes a price, places an order or refuses a customer.
 */
@Injectable()
export class CommerceIntelService {
  private readonly log = new Logger(CommerceIntelService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: CommerceOutboxService,
  ) {}

  async forecast() {
    const since = new Date(Date.now() - WEEKS * 7 * DAY);
    const [listings, sales] = await Promise.all([
      this.prisma.commerceListing.findMany({
        where: {
          status: { in: ['ACTIVE', 'PAUSED'] },
          seller: { code: FASTQUE_SELLER_CODE },
        },
        include: {
          globalProduct: { select: { name: true } },
          batches: true,
          supplierProducts: { include: { supplier: true } },
        },
        take: 2000,
      }),
      this.prisma.$queryRaw<
        Array<{ id: string; week: number; units: bigint }>
      >(Prisma.sql`
        SELECT i."listingId"::text AS id,
               floor(extract(epoch FROM (o."placedAt" - ${since})) / 604800)::int AS week,
               sum(i."quantity") AS units
        FROM "commerce_order_items" i JOIN "commerce_orders" o ON o."id" = i."orderId"
        WHERE o."placedAt" >= ${since} AND o."status" NOT IN ('CANCELLED','RETURNED','RETURN_TO_ORIGIN')
        GROUP BY 1, 2`),
    ]);
    const weekly = new Map<string, number[]>();
    for (const s of sales) {
      const w = weekly.get(s.id) ?? Array<number>(WEEKS).fill(0);
      w[Math.min(WEEKS - 1, Math.max(0, s.week))] += n(s.units);
      weekly.set(s.id, w);
    }
    const today = indiaToday();
    return listings
      .map((l) => {
        const f = forecastDemand(
          weekly.get(l.id) ?? Array<number>(WEEKS).fill(0),
        );
        const available = l.batches
          .filter((b) => !b.expiresOn || b.expiresOn > today)
          .reduce((x, b) => x + b.onHand - b.reserved, 0);
        const leads = l.supplierProducts
          .map((s) => s.supplier.leadTimeDays)
          .filter((x): x is number => x != null);
        const lead = leads.length ? Math.min(...leads) : 7;
        return {
          listingId: l.id,
          product: l.globalProduct.name,
          available,
          forecast: f,
          daysOfStock:
            f && f.weeklyAverage > 0
              ? Math.floor((available / f.weeklyAverage) * 7)
              : null,
          suggestedOrder: f
            ? Math.max(
                0,
                Math.ceil((f.high / 7) * (lead + 14)) +
                  l.safetyStock -
                  available,
              )
            : null,
          note: f
            ? `${f.basis} Order covers ${lead} days lead time plus 14 days at the high end.`
            : 'Not enough sales history for a forecast yet.',
        };
      })
      .sort((a, b) => (a.daysOfStock ?? 1e9) - (b.daysOfStock ?? 1e9));
  }

  async priceSuggestions() {
    const since = new Date(Date.now() - 30 * DAY);
    const today = indiaToday();
    const listings = await this.prisma.commerceListing.findMany({
      where: { status: 'ACTIVE', seller: { code: FASTQUE_SELLER_CODE } },
      include: {
        globalProduct: { select: { name: true } },
        batches: { where: { onHand: { gt: 0 } } },
        orderItems: {
          where: {
            order: {
              placedAt: { gte: since },
              status: { notIn: ['CANCELLED', 'RETURNED', 'RETURN_TO_ORIGIN'] },
            },
          },
          select: { quantity: true },
        },
      },
      take: 2000,
    });
    return listings.flatMap((l) => {
      const live = l.batches.filter((b) => !b.expiresOn || b.expiresOn > today);
      if (!live.length) return [];
      const price = paise(priceNow(l));
      const cost = Math.max(...live.map((b) => paise(b.unitCost.toFixed(2))));
      const sold = l.orderItems.reduce((x, i) => x + i.quantity, 0);
      const expiring = live.filter(
        (b) =>
          b.expiresOn && b.expiresOn.getTime() - today.getTime() <= 60 * DAY,
      );
      const make = (to: number, reason: string) =>
        to === price
          ? []
          : [
              {
                listingId: l.id,
                product: l.globalProduct.name,
                currentPrice: rupeesOf(price),
                suggestedPrice: rupeesOf(to),
                reason,
              },
            ];
      if (expiring.length)
        return make(
          Math.max(cost, Math.round(price * 0.8)),
          `${expiring.reduce((x, b) => x + b.onHand, 0)} unit(s) expire within 60 days. 20% off, never below the cost of ₹${rupeesOf(cost)}.`,
        );
      if (price < cost / 0.9)
        return make(
          Math.min(paise(l.mrp.toFixed(2)), Math.round(cost / 0.85)),
          `Margin is ${(((price - cost) / price) * 100).toFixed(1)}%. This gives 15%, never above MRP.`,
        );
      if (
        !sold &&
        Math.min(...live.map((b) => b.createdAt.getTime())) < since.getTime()
      )
        return make(
          Math.max(cost, Math.round(price * 0.9)),
          `No sales in 30 days. 10% off, never below the cost of ₹${rupeesOf(cost)}.`,
        );
      return [];
    });
  }

  /** Patterns for a person to look at. No order is blocked because of them. */
  async riskSignals() {
    const [address, burst, returns] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ place: string; phones: bigint; orders: bigint }>
      >(Prisma.sql`
        SELECT "shippingAddress"->>'pincode' AS place, count(DISTINCT "contactPhone") AS phones, count(*) AS orders
        FROM "commerce_orders" WHERE "placedAt" > now() - interval '30 days'
        GROUP BY 1, lower(regexp_replace("shippingAddress"->>'line1', '[^a-zA-Z0-9]', '', 'g'))
        HAVING count(DISTINCT "contactPhone") >= 3 ORDER BY 2 DESC LIMIT 20`),
      this.prisma.$queryRaw<
        Array<{ phone: string; orders: bigint }>
      >(Prisma.sql`
        SELECT "contactPhone" AS phone, count(*) AS orders FROM "commerce_orders"
        WHERE "placedAt" > now() - interval '24 hours' GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 20`),
      this.prisma.$queryRaw<
        Array<{ phone: string; returns: bigint; delivered: bigint }>
      >(Prisma.sql`
        SELECT o."contactPhone" AS phone, count(DISTINCT r."id") AS returns, count(DISTINCT o."id") AS delivered
        FROM "commerce_orders" o LEFT JOIN "commerce_returns" r ON r."orderId" = o."id" AND r."status" <> 'REJECTED'
        WHERE o."status" = 'DELIVERED' AND o."placedAt" > now() - interval '180 days'
        GROUP BY 1 HAVING count(DISTINCT r."id") >= 3 AND count(DISTINCT r."id") * 2 >= count(DISTINCT o."id")
        ORDER BY 2 DESC LIMIT 20`),
    ]);
    return [
      ...address.map((a) => ({
        kind: 'SHARED_ADDRESS',
        who: `An address in ${a.place}`,
        message: `${n(a.phones)} phone numbers placed ${n(a.orders)} orders to one address in 30 days.`,
      })),
      ...burst.map((b) => ({
        kind: 'MANY_ORDERS',
        who: `Phone ending ${b.phone.slice(-4)}`,
        message: `${n(b.orders)} orders in 24 hours.`,
      })),
      ...returns.map((r) => ({
        kind: 'MANY_RETURNS',
        who: `Phone ending ${r.phone.slice(-4)}`,
        message: `${n(r.returns)} returns on ${n(r.delivered)} delivered orders in 180 days.`,
      })),
    ];
  }

  // ---------- Reports ----------

  async reports(q: CommerceListQuery, finance: boolean) {
    const from = q.from
      ? new Date(`${q.from}T00:00:00+05:30`)
      : new Date(Date.now() - 30 * DAY);
    const to = q.to ? new Date(`${q.to}T23:59:59.999+05:30`) : new Date();
    const sold = Prisma.sql`"status" NOT IN ('CANCELLED','RETURNED','RETURN_TO_ORIGIN')`;
    const [cohorts, value, warehouses, stats, orders, bags, sellers] =
      await Promise.all([
        this.prisma.$queryRaw<
          Array<{ month: string; customers: bigint; returned: bigint }>
        >(Prisma.sql`
          WITH o AS (SELECT "contactPhone" p, "placedAt" t FROM "commerce_orders" WHERE ${sold}),
               f AS (SELECT p, min(t) first FROM o GROUP BY 1)
          SELECT to_char(f.first AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, count(DISTINCT f.p) AS customers,
                 count(DISTINCT f.p) FILTER (WHERE EXISTS (SELECT 1 FROM o WHERE o.p = f.p AND o.t > f.first)) AS returned
          FROM f GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
        this.prisma.$queryRaw<
          Array<{ customers: bigint; spend: string | null; orders: bigint }>
        >(Prisma.sql`
          SELECT count(DISTINCT "contactPhone") AS customers, sum("total")::text AS spend, count(*) AS orders
          FROM "commerce_orders" WHERE "status" = 'DELIVERED'`),
        this.prisma.$queryRaw<
          Array<{
            code: string;
            name: string;
            orders: bigint;
            delivered: bigint;
            hours: number | null;
          }>
        >(Prisma.sql`
          SELECT w."code", w."name", count(o."id") AS orders,
                 count(o."id") FILTER (WHERE o."status" = 'DELIVERED') AS delivered,
                 avg(extract(epoch FROM (o."shippedAt" - o."placedAt")) / 3600)::float8 AS hours
          FROM "commerce_warehouses" w
          LEFT JOIN "commerce_orders" o ON o."warehouseId" = w."id" AND o."placedAt" >= ${from} AND o."placedAt" <= ${to}
          GROUP BY 1, 2 ORDER BY 1`),
        this.prisma.commerceDailyStat.groupBy({
          by: ['metric'],
          where: {
            day: {
              gte: new Date(from.getTime() + 5.5 * 3600_000),
              lte: new Date(to.getTime() + 5.5 * 3600_000),
            },
          },
          _sum: { count: true },
        }),
        this.prisma.commerceOrder.count({
          where: { placedAt: { gte: from, lte: to } },
        }),
        this.prisma.$queryRaw<Array<{ bags: bigint }>>(Prisma.sql`
          SELECT count(*) AS bags FROM "commerce_saved_bags" b
          WHERE jsonb_array_length(b."items") > 0 AND b."updatedAt" < now() - interval '24 hours'
            AND b."updatedAt" > now() - interval '30 days'
            AND NOT EXISTS (SELECT 1 FROM "commerce_orders" o WHERE o."customerUserId" = b."userId" AND o."placedAt" > b."updatedAt")`),
        this.prisma.commerceTicket.groupBy({ by: ['status'], _count: true }),
      ]);
    const metric = (m: string) =>
      stats.find((s) => s.metric === m)?._sum.count ?? 0;
    const v = value[0];
    const stock = finance
      ? await this.prisma.$queryRaw<
          Array<{ code: string; value: string | null; units: bigint }>
        >(Prisma.sql`
          SELECT w."code", sum(b."onHand" * b."unitCost")::text AS value, coalesce(sum(b."onHand"), 0) AS units
          FROM "commerce_warehouses" w LEFT JOIN "commerce_batches" b ON b."warehouseId" = w."id" GROUP BY 1`)
      : [];
    return {
      retention: cohorts.map((c) => ({
        month: c.month,
        customers: n(c.customers),
        orderedAgain: n(c.returned),
        rate: pct(n(c.returned), n(c.customers)),
      })),
      customerValue: finance
        ? {
            customers: n(v.customers),
            ordersEach: n(v.customers)
              ? (n(v.orders) / n(v.customers)).toFixed(2)
              : null,
            spendEach: n(v.customers)
              ? (Number(v.spend ?? 0) / n(v.customers)).toFixed(2)
              : null,
            basis: 'Delivered FastQue orders so far, per phone number.',
          }
        : null,
      warehouses: warehouses.map((w) => ({
        code: w.code,
        name: w.name,
        orders: n(w.orders),
        delivered: n(w.delivered),
        hoursToShip: w.hours == null ? null : w.hours.toFixed(1),
        stockValue: finance
          ? money(
              new Prisma.Decimal(
                stock.find((s) => s.code === w.code)?.value ?? 0,
              ),
            )
          : null,
      })),
      funnel: {
        productViews: metric('PRODUCT_VIEW'),
        bagViews: metric('BAG_VIEW'),
        checkoutsStarted: metric('CHECKOUT_START'),
        orders,
        ordersPerProductView: pct(orders, metric('PRODUCT_VIEW')),
        basis:
          'Anonymous page counters (views, not people), so treat the rate as approximate.',
      },
      abandonedBags: {
        count: n(bags[0].bags),
        basis:
          'Signed-in customers whose bag has been untouched for 1–30 days with no order since. Guest bags are not tracked.',
      },
      tickets: Object.fromEntries(sellers.map((t) => [t.status, t._count])),
    };
  }

  // ---------- Daily stock alerts ----------

  async stockAlerts() {
    const today = indiaToday();
    const soon = new Date(today.getTime() + 30 * DAY);
    const rows = await this.prisma.commerceListing.findMany({
      where: { status: 'ACTIVE' },
      select: {
        reorderLevel: true,
        globalProduct: { select: { name: true } },
        batches: {
          where: { onHand: { gt: 0 } },
          select: {
            onHand: true,
            reserved: true,
            expiresOn: true,
            batchNumber: true,
          },
        },
      },
      take: 10000,
    });
    const low: string[] = [];
    const expiring: string[] = [];
    for (const l of rows) {
      const live = l.batches.filter((b) => !b.expiresOn || b.expiresOn > today);
      const have = live.reduce((x, b) => x + b.onHand - b.reserved, 0);
      if (l.reorderLevel > 0 && have <= l.reorderLevel)
        low.push(`${l.globalProduct.name}: ${have} left`);
      for (const b of live)
        if (b.expiresOn && b.expiresOn <= soon)
          expiring.push(
            `${l.globalProduct.name}, batch ${b.batchNumber}: ${b.expiresOn.toISOString().slice(0, 10)}`,
          );
    }
    return { low, expiring };
  }

  @Cron('30 3 * * *')
  async sendStockAlerts(): Promise<number> {
    if (!flag('FASTQUE_DIRECT_COMMERCE_ENABLED')) return 0;
    const { low, expiring } = await this.stockAlerts();
    if (!low.length && !expiring.length) return 0;
    const [admins, staff] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          roles: { some: { role: Role.PLATFORM_ADMIN } },
        },
        select: { id: true },
        take: 200,
      }),
      this.prisma.commerceStaffGrant.findMany({
        where: { permission: 'warehouse' },
        select: { userId: true },
      }),
    ]);
    const day = indiaToday().toISOString().slice(0, 10);
    const people = new Set([
      ...admins.map((a) => a.id),
      ...staff.map((s) => s.userId),
    ]);
    for (const userId of people)
      await this.outbox.add(this.prisma, {
        dedupeKey: `commerce-stock:${day}:${userId}`,
        userId,
        type: 'commerce.stock.alert',
        payload: { lowStock: low.length, nearExpiry: expiring.length },
        deepLink: 'dashboard/admin/commerce?tab=inventory',
      });
    this.log.log(
      `Stock alert: ${low.length} low, ${expiring.length} near expiry`,
    );
    return people.size;
  }
}
