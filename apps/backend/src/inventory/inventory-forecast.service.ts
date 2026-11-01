import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFAULT_FORECAST_SETTINGS,
  FORECAST_HISTORY_DAYS,
  FORECAST_METHOD,
  InventoryErrorCode,
  Role,
  addDays,
  convertToStockUnit,
  daysBetween,
  estimateBatches,
  expiryRisks,
  forecastProduct,
  type ForecastSettingsInput,
  type InventoryAlertDto,
  type InventoryAnalyticsDto,
  type InventoryAnalyticsQuery,
  type InventoryPredictionsDto,
  type InventoryUnit,
  type ProductPredictionDto,
  type SupplierLeadTimeInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { DbDeadlineSchedulerService } from '../common/db-deadline-scheduler/db-deadline-scheduler.service';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const ALERT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ALERT_SALONS_PER_RUN = 50;
const EXPIRY_HORIZON_DAYS = 30;
const STATUS_ORDER = {
  OUT_OF_STOCK: 0,
  ORDER_NOW: 1,
  ORDER_SOON: 2,
  OK: 3,
  NO_DATA: 4,
} as const;

function dayString(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const q = (n: number, unit: InventoryUnit) =>
  `${Number(n.toFixed(3))} ${unit === 'EACH' ? 'pcs' : unit.toLowerCase()}`;

type DesiredAlert = {
  kind: 'REORDER' | 'STOCK_OUT' | 'EXPIRING' | 'EXPIRED';
  productId: string;
  dedupeKey: string;
  title: string;
  detail: string;
};

/**
 * Inventory Phase 3 — Smart Prediction. Builds per-product forecasts from the ledger (daily use in
 * the shop's time zone), upcoming bookings × service recipes, supplier lead times and the shop's
 * assumptions; estimates batch expiry (oldest stock used first); keeps one open alert per stock
 * problem and tells the owner once in-app; and produces period analytics. The maths lives in
 * packages/shared (forecastProduct) so it is tested on its own and can be swapped later.
 */
@Injectable()
export class InventoryForecastService implements OnModuleInit {
  private readonly logger = new Logger(InventoryForecastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly scheduler?: DbDeadlineSchedulerService,
  ) {}

  onModuleInit(): void {
    this.scheduler?.register({
      name: 'inventory-alerts',
      domain: 'inventory',
      nextDueAt: () => this.nextAlertDueAt(),
      runDue: () => this.runDueAlerts(),
    });
  }

  // ---------- Settings ----------

  async getSettings(salonId: string): Promise<ForecastSettingsInput> {
    const row = await this.prisma.inventorySettings.findUnique({
      where: { salonId },
    });
    return {
      leadTimeDays: row?.leadTimeDays ?? DEFAULT_FORECAST_SETTINGS.leadTimeDays,
      safetyDays: row?.safetyDays ?? DEFAULT_FORECAST_SETTINGS.safetyDays,
      coverDays: row?.coverDays ?? DEFAULT_FORECAST_SETTINGS.coverDays,
      alertsEnabled: row?.alertsEnabled ?? true,
    };
  }

  async putSettings(
    userId: string,
    salonId: string,
    input: ForecastSettingsInput,
  ): Promise<ForecastSettingsInput> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    await this.prisma.inventorySettings.upsert({
      where: { salonId },
      create: { salonId, ...input },
      update: input,
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'INVENTORY_FORECAST_SETTINGS_UPDATED',
        entityType: 'Salon',
        entityId: salonId,
        metadata: { ...input },
      },
    });
    return this.getSettings(salonId);
  }

  async setSupplierLeadTime(
    userId: string,
    salonId: string,
    supplierId: string,
    input: SupplierLeadTimeInput,
  ): Promise<{ id: string; leadTimeDays: number | null }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const { count } = await this.prisma.inventorySupplier.updateMany({
      where: { id: supplierId, salonId },
      data: { leadTimeDays: input.leadTimeDays },
    });
    if (count === 0)
      throw new AppException(
        InventoryErrorCode.SUPPLIER_NOT_FOUND,
        'That supplier was not found.',
        HttpStatus.NOT_FOUND,
      );
    return { id: supplierId, leadTimeDays: input.leadTimeDays };
  }

  // ---------- Predictions ----------

  async predictions(
    userId: string,
    salonId: string,
  ): Promise<InventoryPredictionsDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const [result, alerts, suppliers] = await Promise.all([
      this.compute(salonId),
      this.openAlerts(salonId),
      this.prisma.inventorySupplier.findMany({
        where: { salonId },
        select: { id: true, name: true, leadTimeDays: true },
        orderBy: { normalizedName: 'asc' },
      }),
    ]);
    return { ...result, alerts, suppliers };
  }

  /** Forecasts for every active product of a shop, most urgent first. */
  async compute(
    salonId: string,
  ): Promise<Omit<InventoryPredictionsDto, 'alerts' | 'suppliers'>> {
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { timezone: true },
    });
    const tz = salon?.timezone || DEFAULT_TZ;
    const now = new Date();
    const today = dayString(now, tz);
    const settings = await this.getSettings(salonId);
    const historyStart = addDays(today, -FORECAST_HISTORY_DAYS);
    const [bounds] = await this.prisma.$queryRaw<
      Array<{ start: Date; end: Date }>
    >(Prisma.sql`SELECT (${historyStart}::date::timestamp AT TIME ZONE ${tz}) AS start,
        (${today}::date::timestamp AT TIME ZONE ${tz}) AS end`);

    const products = await this.prisma.inventoryProduct.findMany({
      where: { salonId, isActive: true },
      select: {
        id: true,
        name: true,
        unit: true,
        usage: true,
        categoryId: true,
        stockOnHand: true,
        reorderThreshold: true,
        minimumOrderQuantity: true,
        contentSize: true,
        contentUnit: true,
        category: { select: { name: true } },
        supplier: { select: { name: true, leadTimeDays: true } },
      },
      orderBy: { normalizedName: 'asc' },
    });
    if (!products.length)
      return {
        asOf: today,
        method: FORECAST_METHOD,
        settings,
        summary: {
          orderNow: 0,
          orderSoon: 0,
          outOfStock: 0,
          notEnoughData: 0,
          expiringAtRisk: 0,
        },
        products: [],
      };

    const [daily, firsts, receipts] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ productId: string; day: string; used: Prisma.Decimal }>
      >(Prisma.sql`
        SELECT "productId", to_char(("recordedAt" AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day,
          SUM(-"quantityDelta") AS used
        FROM "inventory_movements"
        WHERE "salonId" = ${salonId} AND "kind" = 'CONSUMPTION'
          AND "recordedAt" >= ${bounds.start} AND "recordedAt" < ${bounds.end}
        GROUP BY 1, 2`),
      this.prisma.$queryRaw<Array<{ productId: string; first: Date }>>(
        Prisma.sql`SELECT "productId", MIN("recordedAt") AS first FROM "inventory_movements"
          WHERE "salonId" = ${salonId} GROUP BY 1`,
      ),
      this.prisma.inventoryMovement.findMany({
        where: {
          salonId,
          kind: { in: ['OPENING', 'PURCHASE', 'TRANSFER_IN'] },
          recordedAt: { gte: new Date(now.getTime() - 400 * 864e5) },
        },
        select: {
          productId: true,
          quantityDelta: true,
          batchNumber: true,
          expiryDate: true,
          recordedAt: true,
        },
      }),
    ]);
    const booked = await this.bookedDemand(salonId, products, daily, now);

    const out: ProductPredictionDto[] = products.map((p) => {
      const byDay = new Map(
        daily
          .filter((d) => d.productId === p.id)
          .map((d) => [d.day, Number(d.used)]),
      );
      const dailyUse = Array.from(
        { length: FORECAST_HISTORY_DAYS },
        (_, i) => byDay.get(addDays(historyStart, i)) ?? 0,
      );
      const first = firsts.find((f) => f.productId === p.id)?.first;
      const historyDays = first ? daysBetween(dayString(first, tz), today) : 0;
      const leadTimeDays = p.supplier?.leadTimeDays ?? settings.leadTimeDays;
      const stock = Number(p.stockOnHand);
      const demand = booked.get(p.id) ?? 0;
      const f = forecastProduct({
        dailyUse,
        historyDays,
        stockOnHand: stock,
        bookedDemand14Days: demand,
        reorderThreshold: Number(p.reorderThreshold),
        minimumOrderQuantity: p.minimumOrderQuantity
          ? Number(p.minimumOrderQuantity)
          : null,
        settings: { ...settings, leadTimeDays },
        today,
      });
      const batches = estimateBatches(
        stock,
        receipts
          .filter((r) => r.productId === p.id)
          .map((r) => ({
            quantity: Number(r.quantityDelta),
            batchNumber: r.batchNumber,
            expiryDate: r.expiryDate?.toISOString().slice(0, 10) ?? null,
            receivedAt: r.recordedAt.toISOString(),
          })),
      );
      const { method: _method, ...forecast } = f;
      void _method;
      return {
        ...forecast,
        productId: p.id,
        name: p.name,
        categoryName: p.category?.name ?? null,
        supplierName: p.supplier?.name ?? null,
        unit: p.unit,
        stockOnHand: p.stockOnHand.toFixed(3),
        leadTimeDays,
        bookedDemand14Days: Math.round(demand * 1000) / 1000,
        expiry: expiryRisks(batches, f.dailyRate, today, EXPIRY_HORIZON_DAYS),
      };
    });
    out.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) ||
        a.name.localeCompare(b.name),
    );
    return {
      asOf: today,
      method: FORECAST_METHOD,
      settings,
      summary: {
        orderNow: out.filter((p) => p.status === 'ORDER_NOW').length,
        orderSoon: out.filter((p) => p.status === 'ORDER_SOON').length,
        outOfStock: out.filter((p) => p.status === 'OUT_OF_STOCK').length,
        notEnoughData: out.filter((p) => p.confidence === 'NOT_ENOUGH_DATA')
          .length,
        expiringAtRisk: out.filter((p) => p.expiry.some((e) => e.atRisk > 0))
          .length,
      },
      products: out,
    };
  }

  /**
   * What the next 14 days of confirmed bookings are expected to use, per product (stock units):
   * each booked service × its recipe lines. A line's product is its usual product, else the
   * product of that category used most in the history window, else the first one on the services
   * shelf. Only an estimate — it never deducts anything.
   */
  private async bookedDemand(
    salonId: string,
    products: Array<{
      id: string;
      usage: string;
      categoryId: string | null;
      unit: InventoryUnit;
      contentSize: Prisma.Decimal | null;
      contentUnit: InventoryUnit | null;
    }>,
    daily: Array<{ productId: string; used: Prisma.Decimal }>,
    now: Date,
  ): Promise<Map<string, number>> {
    const counts = await this.prisma.$queryRaw<
      Array<{ serviceId: string; n: bigint }>
    >(Prisma.sql`
      SELECT bs."serviceId", COUNT(*) AS n
      FROM "booking_services" bs JOIN "bookings" b ON b."id" = bs."bookingId"
      WHERE b."salonId" = ${salonId} AND b."status" = 'CONFIRMED'
        AND b."slotStart" >= ${now} AND b."slotStart" < ${new Date(now.getTime() + 14 * 864e5)}
      GROUP BY 1`);
    const demand = new Map<string, number>();
    if (!counts.length) return demand;
    const rules = await this.prisma.serviceProductRule.findMany({
      where: { salonId, serviceId: { in: counts.map((c) => c.serviceId) } },
      select: {
        serviceId: true,
        inventoryCategoryId: true,
        defaultProductId: true,
        quantity: true,
        unit: true,
      },
    });
    const usedTotal = new Map<string, number>();
    for (const d of daily)
      usedTotal.set(
        d.productId,
        (usedTotal.get(d.productId) ?? 0) + Number(d.used),
      );
    for (const rule of rules) {
      const n = Number(
        counts.find((c) => c.serviceId === rule.serviceId)?.n ?? 0,
      );
      const candidates = products.filter(
        (p) =>
          p.categoryId === rule.inventoryCategoryId &&
          p.usage === 'PROFESSIONAL',
      );
      const product =
        candidates.find((p) => p.id === rule.defaultProductId) ??
        [...candidates].sort(
          (a, b) => (usedTotal.get(b.id) ?? 0) - (usedTotal.get(a.id) ?? 0),
        )[0];
      if (!product || !n) continue;
      const converted = convertToStockUnit(Number(rule.quantity), rule.unit, {
        unit: product.unit,
        contentSize: product.contentSize?.toString() ?? null,
        contentUnit: product.contentUnit,
      });
      if (!converted.ok) continue;
      demand.set(
        product.id,
        (demand.get(product.id) ?? 0) + converted.quantity * n,
      );
    }
    return demand;
  }

  // ---------- Alerts ----------

  private async openAlerts(salonId: string): Promise<InventoryAlertDto[]> {
    const rows = await this.prisma.inventoryAlert.findMany({
      where: { salonId, resolvedAt: null, dismissedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      productId: a.productId,
      title: a.title,
      detail: a.detail,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  async dismissAlert(
    userId: string,
    salonId: string,
    alertId: string,
  ): Promise<void> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const { count } = await this.prisma.inventoryAlert.updateMany({
      where: { id: alertId, salonId, dismissedAt: null },
      data: { dismissedAt: new Date(), dismissedByUserId: userId },
    });
    if (count === 0)
      throw new AppException(
        'INVENTORY_ALERT_NOT_FOUND',
        'That alert was not found or was already dismissed.',
        HttpStatus.NOT_FOUND,
      );
  }

  async runAlertsNow(
    userId: string,
    salonId: string,
  ): Promise<{ created: number; resolved: number }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    return this.runAlerts(salonId);
  }

  /**
   * Brings a shop's open alerts in line with today's forecast: new problems get an alert (and one
   * in-app notification per kind to the owners), problems that went away are resolved. Re-running
   * on the same day changes nothing.
   */
  async runAlerts(
    salonId: string,
  ): Promise<{ created: number; resolved: number }> {
    const settings = await this.getSettings(salonId);
    const now = new Date();
    if (!settings.alertsEnabled) {
      await this.markRun(salonId, now);
      return { created: 0, resolved: 0 };
    }
    const { products } = await this.compute(salonId);
    const desired: DesiredAlert[] = [];
    for (const p of products) {
      if (p.status === 'OUT_OF_STOCK')
        desired.push({
          kind: 'STOCK_OUT',
          productId: p.productId,
          dedupeKey: `STOCK_OUT:${p.productId}`,
          title: `${p.name} is out of stock`,
          detail: p.suggestedOrderQuantity
            ? `Suggested order: ${q(p.suggestedOrderQuantity, p.unit)}.`
            : 'Record a purchase when it arrives.',
        });
      else if (p.status === 'ORDER_NOW')
        desired.push({
          kind: 'REORDER',
          productId: p.productId,
          dedupeKey: `REORDER:${p.productId}`,
          title: `Reorder ${p.name}`,
          detail:
            `${p.explanation}${p.suggestedOrderQuantity ? ` Suggested order: ${q(p.suggestedOrderQuantity, p.unit)}.` : ''}`.slice(
              0,
              500,
            ),
        });
      for (const e of p.expiry) {
        const expired = e.daysToExpiry < 0;
        if (!expired && e.atRisk <= 0 && e.daysToExpiry > 7) continue;
        const batch = e.batchNumber ? ` (batch ${e.batchNumber})` : '';
        desired.push({
          kind: expired ? 'EXPIRED' : 'EXPIRING',
          productId: p.productId,
          dedupeKey:
            `${expired ? 'EXPIRED' : 'EXPIRING'}:${p.productId}:${e.batchNumber ?? '-'}:${e.expiryDate}`.slice(
              0,
              160,
            ),
          title: expired
            ? `${p.name}${batch} expired on ${e.expiryDate}`
            : `${p.name}${batch} expires on ${e.expiryDate}`,
          detail: expired
            ? `About ${q(e.remaining, p.unit)} may still be on the shelf. Record it as expired once removed.`
            : e.atRisk > 0
              ? `About ${q(e.atRisk, p.unit)} may not be used in time at the current rate. Use it first.`
              : 'Use this batch first.',
        });
      }
    }

    const open = await this.prisma.inventoryAlert.findMany({
      where: { salonId, resolvedAt: null },
      select: { id: true, dedupeKey: true },
    });
    const wanted = new Set(desired.map((d) => d.dedupeKey));
    const toResolve = open.filter((a) => !wanted.has(a.dedupeKey));
    if (toResolve.length)
      await this.prisma.inventoryAlert.updateMany({
        where: { id: { in: toResolve.map((a) => a.id) } },
        data: { resolvedAt: now },
      });
    const existing = new Set(open.map((a) => a.dedupeKey));
    const created: DesiredAlert[] = [];
    for (const d of desired) {
      if (existing.has(d.dedupeKey)) continue;
      try {
        await this.prisma.inventoryAlert.create({ data: { salonId, ...d } });
        created.push(d);
      } catch (error) {
        // Another run created it a moment ago: the partial unique index kept it to one.
        if (!(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ))
          throw error;
      }
    }
    if (created.length) await this.notifyOwners(salonId, created);
    await this.markRun(salonId, now);
    return { created: created.length, resolved: toResolve.length };
  }

  private async notifyOwners(
    salonId: string,
    created: DesiredAlert[],
  ): Promise<void> {
    const owners = await this.prisma.userRole.findMany({
      where: { salonId, role: Role.SALON_OWNER },
      select: { userId: true },
    });
    const deepLink = `dashboard/salons/${salonId}/inventory/predictions`;
    const reorder = created.filter(
      (c) => c.kind === 'REORDER' || c.kind === 'STOCK_OUT',
    );
    const expiry = created.filter(
      (c) => c.kind === 'EXPIRING' || c.kind === 'EXPIRED',
    );
    for (const { userId } of owners) {
      if (reorder.length)
        await this.notifications.notify(
          userId,
          'owner.inventory.reorder',
          {
            salonId,
            count: reorder.length,
            items: reorder.slice(0, 5).map((c) => c.title),
          },
          deepLink,
        );
      if (expiry.length)
        await this.notifications.notify(
          userId,
          'owner.inventory.expiring',
          {
            salonId,
            count: expiry.length,
            items: expiry.slice(0, 5).map((c) => c.title),
          },
          deepLink,
        );
    }
  }

  private async markRun(salonId: string, at: Date): Promise<void> {
    await this.prisma.inventorySettings.upsert({
      where: { salonId },
      create: { salonId, lastAlertRunAt: at },
      update: { lastAlertRunAt: at },
    });
  }

  /** Shops with active products whose daily check is due (never run, or more than a day ago). */
  private async dueSalons(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ salonId: string }>>(
      Prisma.sql`
        SELECT p."salonId" FROM "inventory_products" p
        LEFT JOIN "inventory_settings" s ON s."salonId" = p."salonId"
        WHERE p."isActive" = true
          AND (s."lastAlertRunAt" IS NULL OR s."lastAlertRunAt" <= ${new Date(Date.now() - ALERT_INTERVAL_MS)})
        GROUP BY p."salonId"
        LIMIT ${limit}`,
    );
    return rows.map((r) => r.salonId);
  }

  private async nextAlertDueAt(): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<
      Array<{ last: Date | null; never: bigint }>
    >(Prisma.sql`
      SELECT MIN(s."lastAlertRunAt") AS last, COUNT(*) FILTER (WHERE s."lastAlertRunAt" IS NULL) AS never
      FROM (SELECT DISTINCT "salonId" FROM "inventory_products" WHERE "isActive" = true) p
      LEFT JOIN "inventory_settings" s ON s."salonId" = p."salonId"`);
    if (!row) return null;
    if (Number(row.never) > 0) return new Date();
    return row.last ? new Date(row.last.getTime() + ALERT_INTERVAL_MS) : null;
  }

  async runDueAlerts(): Promise<void> {
    for (const salonId of await this.dueSalons(ALERT_SALONS_PER_RUN)) {
      try {
        await this.runAlerts(salonId);
      } catch (err) {
        this.logger.warn(
          `Inventory alerts failed for salon ${salonId}: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
        await this.markRun(salonId, new Date()).catch(() => undefined);
      }
    }
  }

  // ---------- Analytics (reports) ----------

  async analytics(
    userId: string,
    salonId: string,
    query: InventoryAnalyticsQuery,
  ): Promise<InventoryAnalyticsDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { timezone: true, currency: true },
    });
    const tz = salon?.timezone || DEFAULT_TZ;
    const to = query.to ?? dayString(new Date(), tz);
    const from = query.from ?? addDays(to, -((query.days ?? 30) - 1));
    if (from > to || daysBetween(from, to) > 366)
      throw new AppException(
        InventoryErrorCode.INVALID_MOVEMENT,
        'Choose a period of up to a year, with the start before the end.',
        HttpStatus.BAD_REQUEST,
      );
    const [bounds] = await this.prisma.$queryRaw<
      Array<{ start: Date; end: Date }>
    >(Prisma.sql`SELECT (${from}::date::timestamp AT TIME ZONE ${tz}) AS start,
        ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AS end`);
    const sums = Prisma.sql`
      SUM(m."quantityDelta") FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')) AS rq,
      SUM(m."quantityDelta" * m."unitCost") FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')) AS rv,
      SUM(-m."quantityDelta") FILTER (WHERE m."kind" = 'CONSUMPTION') AS uq,
      SUM(-m."quantityDelta" * m."averageUnitCostAfter") FILTER (WHERE m."kind" = 'CONSUMPTION') AS uv,
      SUM(-m."quantityDelta") FILTER (WHERE m."kind" IN ('DAMAGE', 'EXPIRY', 'WASTAGE')) AS lq,
      SUM(-m."quantityDelta" * m."averageUnitCostAfter") FILTER (WHERE m."kind" IN ('DAMAGE', 'EXPIRY', 'WASTAGE')) AS lv`;
    type Sums = {
      rq: Prisma.Decimal | null;
      rv: Prisma.Decimal | null;
      uq: Prisma.Decimal | null;
      uv: Prisma.Decimal | null;
      lq: Prisma.Decimal | null;
      lv: Prisma.Decimal | null;
    };
    const inRange = Prisma.sql`m."salonId" = ${salonId} AND m."recordedAt" >= ${bounds.start} AND m."recordedAt" < ${bounds.end}`;
    const [perProduct, perWeek, perCategory, stock] = await Promise.all([
      this.prisma.$queryRaw<Array<Sums & { productId: string }>>(
        Prisma.sql`SELECT m."productId", ${sums} FROM "inventory_movements" m WHERE ${inRange} GROUP BY 1`,
      ),
      this.prisma.$queryRaw<Array<Sums & { week: string }>>(
        Prisma.sql`SELECT to_char(date_trunc('week', (m."recordedAt" AT TIME ZONE ${tz}))::date, 'YYYY-MM-DD') AS week, ${sums}
          FROM "inventory_movements" m WHERE ${inRange} GROUP BY 1 ORDER BY 1`,
      ),
      this.prisma.$queryRaw<Array<Sums & { categoryName: string | null }>>(
        Prisma.sql`SELECT c."name" AS "categoryName", ${sums}
          FROM "inventory_movements" m JOIN "inventory_products" p ON p."id" = m."productId"
          LEFT JOIN "inventory_categories" c ON c."id" = p."categoryId"
          WHERE ${inRange} GROUP BY 1 ORDER BY 1`,
      ),
      this.prisma.inventoryProduct.findMany({
        where: { salonId },
        select: {
          id: true,
          name: true,
          unit: true,
          isActive: true,
          stockOnHand: true,
          averageUnitCost: true,
          category: { select: { name: true } },
        },
        orderBy: { normalizedName: 'asc' },
      }),
    ]);
    const n = (v: Prisma.Decimal | null | undefined, places: number) =>
      (v ?? new Prisma.Decimal(0)).toFixed(places);
    const rows = stock
      .map((p) => {
        const s = perProduct.find((r) => r.productId === p.id);
        return { p, s };
      })
      .filter(({ p, s }) => p.isActive || s);
    const sum = (k: 'rv' | 'uv' | 'lv') =>
      perProduct
        .reduce((a, r) => a.plus(r[k] ?? 0), new Prisma.Decimal(0))
        .toFixed(2);
    return {
      range: { from, to },
      currency: salon?.currency ?? null,
      totals: {
        receivedValue: sum('rv'),
        usedValue: sum('uv'),
        lostValue: sum('lv'),
        stockValue: stock
          .filter((p) => p.isActive)
          .reduce(
            (a, p) => a.plus(p.stockOnHand.times(p.averageUnitCost)),
            new Prisma.Decimal(0),
          )
          .toFixed(2),
      },
      byWeek: perWeek.map((w) => ({
        weekStart: w.week,
        usedValue: n(w.uv, 2),
        receivedValue: n(w.rv, 2),
        lostValue: n(w.lv, 2),
      })),
      byCategory: perCategory.map((c) => ({
        categoryName: c.categoryName ?? 'No category',
        usedValue: n(c.uv, 2),
        receivedValue: n(c.rv, 2),
      })),
      products: rows.map(({ p, s }) => ({
        productId: p.id,
        name: p.name,
        categoryName: p.category?.name ?? null,
        unit: p.unit,
        receivedQuantity: n(s?.rq, 3),
        receivedValue: n(s?.rv, 2),
        usedQuantity: n(s?.uq, 3),
        usedValue: n(s?.uv, 2),
        lostQuantity: n(s?.lq, 3),
        lostValue: n(s?.lv, 2),
        stockOnHand: p.stockOnHand.toFixed(3),
        stockValue: p.stockOnHand.times(p.averageUnitCost).toFixed(2),
      })),
    };
  }
}
