import { createHash } from 'crypto';
import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  InventoryErrorCode,
  ServiceUsageErrorCode,
  convertToStockUnit,
  suggestCategoriesForService,
  type InventoryDashboardDto,
  type InventoryDashboardQuery,
  type InventoryUnit,
  type PutServiceRecipeInput,
  type RecordServiceUsageInput,
  type RecordServiceUsageResultDto,
  type ReverseServiceUsageInput,
  type ServiceRecipeDto,
  type ServiceRecipeLineDto,
  type ServiceVisitDto,
  type ServiceVisitsDto,
  type ServiceVisitsQuery,
  type UsageProductOptionDto,
  type UsageRecordDto,
  type VisitUsageOptionsDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ServiceCompletedHook,
  type ServiceCompletedEvent,
} from '../queue/service-completed.hook';

const TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 15000,
};
const DEFAULT_TZ = 'Asia/Kolkata';
/** How long after completion a barber may still record products for their own visit. */
const STAFF_RECORD_WINDOW_MS = 12 * 60 * 60 * 1000;
const LOSS_KINDS = ['DAMAGE', 'EXPIRY', 'WASTAGE'] as const;

const ruleInclude = {
  inventoryCategory: { select: { name: true } },
  defaultProduct: { select: { name: true, isActive: true } },
} satisfies Prisma.ServiceProductRuleInclude;
type RuleRow = Prisma.ServiceProductRuleGetPayload<{
  include: typeof ruleInclude;
}>;

const usageInclude = {
  staff: { select: { displayName: true } },
  items: {
    include: { product: { select: { name: true, unit: true } } },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.ServiceUsageInclude;
type UsageRow = Prisma.ServiceUsageGetPayload<{ include: typeof usageInclude }>;

const visitInclude = {
  service: { select: { id: true, name: true } },
  booking: {
    select: {
      services: {
        orderBy: { sortOrder: 'asc' as const },
        select: { serviceId: true, serviceName: true },
      },
    },
  },
  serviceSessions: { select: { staffId: true } },
  assignedStaff: { select: { displayName: true } },
} satisfies Prisma.QueueEntryInclude;
type VisitRow = Prisma.QueueEntryGetPayload<{ include: typeof visitInclude }>;

type ActorKind = 'OWNER' | 'STAFF' | 'PLATFORM_ADMIN';

/** The services performed in one visit: a booking's services in order, else the entry's service. */
function visitServices(entry: VisitRow): { id: string; name: string }[] {
  const booked = entry.booking?.services ?? [];
  if (booked.length)
    return booked.map((s) => ({ id: s.serviceId, name: s.serviceName }));
  return entry.service
    ? [{ id: entry.service.id, name: entry.service.name }]
    : [];
}

function toRuleDto(rule: RuleRow): ServiceRecipeLineDto {
  return {
    id: rule.id,
    inventoryCategoryId: rule.inventoryCategoryId,
    categoryName: rule.inventoryCategory.name,
    quantity: rule.quantity.toFixed(3),
    unit: rule.unit,
    defaultProductId: rule.defaultProductId,
    defaultProductName: rule.defaultProduct?.name ?? null,
    autoDeduct: rule.autoDeduct,
  };
}

function toUsageDto(row: UsageRow): UsageRecordDto {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    recordedAt: row.recordedAt.toISOString(),
    staffName: row.staff?.displayName ?? null,
    items: row.items.map((i) => ({
      productId: i.productId,
      productName: i.product.name,
      quantity: i.quantity.toFixed(3),
      unit: i.product.unit,
      enteredQuantity: i.enteredQuantity.toFixed(3),
      enteredUnit: i.enteredUnit,
    })),
  };
}

/** Same products and amounts as already recorded — a retry or second tap, not a change. */
function sameItems(
  existing: UsageRow,
  items: { productId: string; quantity: number; unit: InventoryUnit }[],
): boolean {
  if (existing.items.length !== items.length) return false;
  return items.every((i) =>
    existing.items.some(
      (e) =>
        e.productId === i.productId &&
        e.enteredUnit === i.unit &&
        e.enteredQuantity.equals(new Prisma.Decimal(i.quantity.toFixed(3))),
    ),
  );
}

function dayString(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Inventory Phase 2 — Service Consumption. Salon recipes ("Shaving: shaving cream 10 ml, blade 1"),
 * the photo picker's options for one visit, recording the products used (one transaction for the
 * whole visit, at most once per service per visit), owner corrections, salon-approved automatic
 * deduction on completion, the visits-without-usage list and the inventory dashboard. Every stock
 * change is an append-only ledger entry; the database trigger keeps stock and average cost.
 */
@Injectable()
export class ServiceUsageService implements OnModuleInit {
  private readonly logger = new Logger(ServiceUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly serviceCompleted: ServiceCompletedHook,
  ) {}

  onModuleInit(): void {
    this.serviceCompleted.register((event) => this.autoRecord(event));
  }

  // ---------- Recipes ----------

  async listRecipes(
    userId: string,
    salonId: string,
  ): Promise<ServiceRecipeDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const [services, rules] = await Promise.all([
      this.prisma.service.findMany({
        where: { salonId },
        select: { id: true, name: true, category: true, isActive: true },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.serviceProductRule.findMany({
        where: { salonId },
        include: ruleInclude,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return services.map((s) => {
      const lines = rules.filter((r) => r.serviceId === s.id);
      const used = new Set(
        lines.map((l) => l.inventoryCategory.name.trim().toLowerCase()),
      );
      return {
        serviceId: s.id,
        serviceName: s.name,
        serviceCategory: s.category,
        isActive: s.isActive,
        lines: lines.map(toRuleDto),
        suggestions: suggestCategoriesForService(s).filter(
          (c) => !used.has(c.toLowerCase()),
        ),
      };
    });
  }

  /** Replaces a service's recipe lines (owner/admin). Categories and products must be this salon's. */
  async putRecipe(
    userId: string,
    salonId: string,
    serviceId: string,
    input: PutServiceRecipeInput,
  ): Promise<ServiceRecipeDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, salonId },
      select: { id: true, name: true, category: true, isActive: true },
    });
    if (!service)
      throw new AppException(
        ServiceUsageErrorCode.INVALID_RECIPE,
        'That service was not found in this shop.',
        HttpStatus.NOT_FOUND,
      );
    const categoryIds = input.lines.map((l) => l.inventoryCategoryId);
    const productIds = input.lines
      .map((l) => l.defaultProductId)
      .filter((id): id is string => !!id);
    const [categories, products] = await Promise.all([
      this.prisma.inventoryCategory.findMany({
        where: { salonId, id: { in: categoryIds } },
        select: { id: true },
      }),
      this.prisma.inventoryProduct.findMany({
        where: { salonId, id: { in: productIds }, isActive: true },
        select: {
          id: true,
          name: true,
          categoryId: true,
          unit: true,
          contentSize: true,
          contentUnit: true,
        },
      }),
    ]);
    if (categories.length !== new Set(categoryIds).size)
      throw new AppException(
        ServiceUsageErrorCode.INVALID_RECIPE,
        'One of the product categories was not found in this shop.',
        HttpStatus.BAD_REQUEST,
      );
    for (const line of input.lines) {
      if (!line.defaultProductId) continue;
      const product = products.find((p) => p.id === line.defaultProductId);
      if (!product || product.categoryId !== line.inventoryCategoryId)
        throw new AppException(
          ServiceUsageErrorCode.INVALID_RECIPE,
          'The default product must be an active product in that category.',
          HttpStatus.BAD_REQUEST,
        );
      const converted = convertToStockUnit(line.quantity, line.unit, {
        unit: product.unit,
        contentSize: product.contentSize?.toString() ?? null,
        contentUnit: product.contentUnit,
      });
      if (!converted.ok)
        throw new AppException(
          ServiceUsageErrorCode.UNIT_MISMATCH,
          `${product.name}: ${converted.reason}`,
          HttpStatus.BAD_REQUEST,
        );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.serviceProductRule.deleteMany({
        where: {
          salonId,
          serviceId,
          inventoryCategoryId: { notIn: categoryIds },
        },
      });
      for (const [index, line] of input.lines.entries()) {
        const data = {
          quantity: new Prisma.Decimal(line.quantity.toFixed(3)),
          unit: line.unit,
          defaultProductId: line.defaultProductId ?? null,
          autoDeduct: line.autoDeduct,
          sortOrder: index,
        };
        await tx.serviceProductRule.upsert({
          where: {
            serviceId_inventoryCategoryId: {
              serviceId,
              inventoryCategoryId: line.inventoryCategoryId,
            },
          },
          create: {
            salonId,
            serviceId,
            inventoryCategoryId: line.inventoryCategoryId,
            ...data,
          },
          update: data,
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'SERVICE_RECIPE_UPDATED',
          entityType: 'Service',
          entityId: serviceId,
          metadata: {
            salonId,
            lines: input.lines.map((l) => ({
              inventoryCategoryId: l.inventoryCategoryId,
              quantity: l.quantity,
              unit: l.unit,
              defaultProductId: l.defaultProductId ?? null,
              autoDeduct: l.autoDeduct,
            })),
          },
        },
      });
    }, TX);
    const recipes = await this.listRecipes(userId, salonId);
    return recipes.find((r) => r.serviceId === serviceId)!;
  }

  // ---------- One visit: picker options, recording ----------

  async getVisitOptions(
    userId: string,
    queueEntryId: string,
  ): Promise<VisitUsageOptionsDto> {
    const { entry } = await this.visitAccess(userId, queueEntryId, 'view');
    const services = visitServices(entry);
    const serviceIds = services.map((s) => s.id);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [rules, products, recent, recorded] = await Promise.all([
      this.prisma.serviceProductRule.findMany({
        where: { salonId: entry.salonId, serviceId: { in: serviceIds } },
        include: ruleInclude,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.inventoryProduct.findMany({
        where: {
          salonId: entry.salonId,
          isActive: true,
          usage: 'PROFESSIONAL',
        },
        select: {
          id: true,
          name: true,
          categoryId: true,
          stockOnHand: true,
          unit: true,
          contentSize: true,
          contentUnit: true,
          globalProduct: {
            select: {
              brand: true,
              images: { orderBy: { sortOrder: 'asc' }, take: 1 },
            },
          },
        },
        orderBy: { normalizedName: 'asc' },
        take: 500,
      }),
      this.prisma.serviceUsageItem.findMany({
        where: {
          salonId: entry.salonId,
          usage: { status: 'RECORDED', recordedAt: { gte: since } },
        },
        select: { productId: true },
        orderBy: { usage: { recordedAt: 'desc' } },
        take: 300,
      }),
      this.prisma.serviceUsage.findMany({
        where: {
          queueEntryId,
          status: 'RECORDED',
          serviceId: { in: serviceIds },
        },
        include: usageInclude,
      }),
    ]);
    const recentRank = new Map<string, number>();
    for (const r of recent)
      if (!recentRank.has(r.productId))
        recentRank.set(r.productId, recentRank.size);
    const options: UsageProductOptionDto[] = products.map((p) => ({
      productId: p.id,
      name: p.name,
      brand: p.globalProduct?.brand ?? null,
      imageUrl: p.globalProduct?.images[0]?.url ?? null,
      categoryId: p.categoryId,
      stockOnHand: p.stockOnHand.toFixed(3),
      unit: p.unit,
      contentSize: p.contentSize?.toFixed(3) ?? null,
      contentUnit: p.contentUnit,
      recentRank: recentRank.get(p.id) ?? null,
    }));
    const order = (defaultId: string | null) => (a: string, b: string) => {
      if (a === defaultId) return -1;
      if (b === defaultId) return 1;
      const ra = recentRank.get(a) ?? Infinity;
      const rb = recentRank.get(b) ?? Infinity;
      return ra - rb;
    };
    const serviceDtos = services.map((s) => {
      const lines = rules
        .filter((r) => r.serviceId === s.id)
        .map((r) => ({
          ...toRuleDto(r),
          productIds: options
            .filter((o) => o.categoryId === r.inventoryCategoryId)
            .map((o) => o.productId)
            .sort(order(r.defaultProductId)),
        }));
      const usage = recorded.find((u) => u.serviceId === s.id);
      return {
        serviceId: s.id,
        serviceName: s.name,
        lines,
        recorded: usage ? toUsageDto(usage) : null,
      };
    });
    return {
      queueEntryId: entry.id,
      salonId: entry.salonId,
      tokenNumber: entry.tokenNumber,
      customerName: entry.contactName ?? null,
      status: entry.status,
      services: serviceDtos,
      products: options,
      hasAnythingToRecord: serviceDtos.some((s) => s.lines.length > 0),
    };
  }

  async recordForVisit(
    userId: string,
    queueEntryId: string,
    input: RecordServiceUsageInput,
  ): Promise<RecordServiceUsageResultDto> {
    const { entry, staffId } = await this.visitAccess(
      userId,
      queueEntryId,
      'record',
    );
    return this.record(userId, entry, staffId, input, 'MANUAL');
  }

  /**
   * Writes the usage for one visit in ONE transaction: every product is locked (in id order, so
   * concurrent writers can't deadlock), stock is checked for the whole visit, then each line gets
   * its own CONSUMPTION ledger entry. A service already recorded with the same products is returned
   * as-is (retry / double tap); with different products it is refused — correct it instead.
   */
  private async record(
    userId: string,
    entry: VisitRow,
    staffId: string | null,
    input: RecordServiceUsageInput,
    source: 'MANUAL' | 'AUTO',
  ): Promise<RecordServiceUsageResultDto> {
    const services = visitServices(entry);
    for (const s of input.services)
      if (!services.some((v) => v.id === s.serviceId))
        throw new AppException(
          ServiceUsageErrorCode.NO_SERVICES,
          'That service is not part of this visit.',
          HttpStatus.BAD_REQUEST,
        );
    const productIds = [
      ...new Set(
        input.services.flatMap((s) => s.items.map((i) => i.productId)),
      ),
    ];
    const products = await this.prisma.inventoryProduct.findMany({
      where: { salonId: entry.salonId, id: { in: productIds }, isActive: true },
      select: {
        id: true,
        name: true,
        unit: true,
        contentSize: true,
        contentUnit: true,
      },
    });
    const rules = await this.prisma.serviceProductRule.findMany({
      where: {
        salonId: entry.salonId,
        serviceId: { in: input.services.map((s) => s.serviceId) },
      },
      select: { id: true, serviceId: true },
    });
    const planned = input.services.map((s) => ({
      serviceId: s.serviceId,
      serviceName: services.find((v) => v.id === s.serviceId)!.name,
      items: s.items.map((i) => {
        const product = products.find((p) => p.id === i.productId);
        if (!product)
          throw new AppException(
            InventoryErrorCode.PRODUCT_NOT_FOUND,
            'One of the products is not an active product of this shop.',
            HttpStatus.BAD_REQUEST,
          );
        const converted = convertToStockUnit(i.quantity, i.unit, {
          unit: product.unit,
          contentSize: product.contentSize?.toString() ?? null,
          contentUnit: product.contentUnit,
        });
        if (!converted.ok)
          throw new AppException(
            ServiceUsageErrorCode.UNIT_MISMATCH,
            `${product.name}: ${converted.reason}`,
            HttpStatus.BAD_REQUEST,
          );
        return {
          ...i,
          productName: product.name,
          stockQuantity: new Prisma.Decimal(converted.quantity.toFixed(3)),
          ruleId: rules.some(
            (r) => r.id === i.ruleId && r.serviceId === s.serviceId,
          )
            ? i.ruleId!
            : null,
        };
      }),
    }));

    try {
      return await this.prisma.$transaction(async (tx) => {
        const results: RecordServiceUsageResultDto['services'] = [];
        const toWrite: typeof planned = [];
        for (const s of planned) {
          const existing = await tx.serviceUsage.findFirst({
            where: {
              queueEntryId: entry.id,
              serviceId: s.serviceId,
              status: 'RECORDED',
            },
            include: usageInclude,
          });
          if (!existing) {
            toWrite.push(s);
            continue;
          }
          if (!sameItems(existing, s.items))
            throw new AppException(
              ServiceUsageErrorCode.ALREADY_RECORDED,
              `Products for ${s.serviceName} were already recorded for this visit. Correct them from Inventory → Product usage.`,
              HttpStatus.CONFLICT,
            );
          results.push({
            serviceId: s.serviceId,
            usage: toUsageDto(existing),
            created: false,
          });
        }
        if (!toWrite.length) return { services: results };

        const ids = [
          ...new Set(toWrite.flatMap((s) => s.items.map((i) => i.productId))),
        ].sort();
        const locked = await tx.$queryRaw<
          Array<{ id: string; stockOnHand: Prisma.Decimal }>
        >(Prisma.sql`
          SELECT "id", "stockOnHand" FROM "inventory_products"
          WHERE "salonId" = ${entry.salonId} AND "id" IN (${Prisma.join(ids)})
          ORDER BY "id" FOR UPDATE
        `);
        const needed = new Map<string, Prisma.Decimal>();
        for (const s of toWrite)
          for (const i of s.items)
            needed.set(
              i.productId,
              (needed.get(i.productId) ?? new Prisma.Decimal(0)).plus(
                i.stockQuantity,
              ),
            );
        const short = [...needed.entries()].filter(([id, qty]) => {
          const row = locked.find((l) => l.id === id);
          return !row || row.stockOnHand.lessThan(qty);
        });
        if (short.length) {
          const names = short.map(([id, qty]) => {
            const p = products.find((x) => x.id === id)!;
            const left = locked.find((l) => l.id === id)?.stockOnHand;
            return `${p.name} (needs ${qty.toFixed(3)}, ${left?.toFixed(3) ?? '0'} left)`;
          });
          throw new AppException(
            InventoryErrorCode.INSUFFICIENT_STOCK,
            `Not enough stock recorded for: ${names.join(', ')}. Record the purchase first, or adjust the amounts.`,
            HttpStatus.CONFLICT,
          );
        }

        for (const s of toWrite) {
          const usage = await tx.serviceUsage.create({
            data: {
              salonId: entry.salonId,
              queueEntryId: entry.id,
              serviceId: s.serviceId,
              staffId,
              source,
              recordedByUserId: userId,
            },
          });
          for (const i of s.items) {
            const key = `svc-usage:${usage.id}:${i.productId}`;
            const movement = await tx.inventoryMovement.create({
              data: {
                salonId: entry.salonId,
                productId: i.productId,
                actorUserId: userId,
                kind: 'CONSUMPTION',
                quantityDelta: i.stockQuantity.negated(),
                reason:
                  `Used for ${s.serviceName} (token ${entry.tokenNumber})`.slice(
                    0,
                    300,
                  ),
                reference: `service-usage:${usage.id}`,
                idempotencyKey: key,
                requestHash: createHash('sha256').update(key).digest('hex'),
              },
              select: { id: true },
            });
            await tx.serviceUsageItem.create({
              data: {
                usageId: usage.id,
                salonId: entry.salonId,
                productId: i.productId,
                ruleId: i.ruleId,
                quantity: i.stockQuantity,
                enteredQuantity: new Prisma.Decimal(i.quantity.toFixed(3)),
                enteredUnit: i.unit,
                movementId: movement.id,
              },
            });
          }
          await tx.auditLog.create({
            data: {
              actorUserId: userId,
              action: 'SERVICE_USAGE_RECORDED',
              entityType: 'ServiceUsage',
              entityId: usage.id,
              metadata: {
                salonId: entry.salonId,
                queueEntryId: entry.id,
                serviceId: s.serviceId,
                source,
                items: s.items.map((i) => ({
                  productId: i.productId,
                  quantity: i.stockQuantity.toFixed(3),
                })),
              },
            },
          });
          const saved = await tx.serviceUsage.findUniqueOrThrow({
            where: { id: usage.id },
            include: usageInclude,
          });
          results.push({
            serviceId: s.serviceId,
            usage: toUsageDto(saved),
            created: true,
          });
        }
        return { services: results };
      }, TX);
    } catch (error) {
      // Two devices recorded the same service at the same moment: the partial unique index let
      // exactly one through. Answer with that one if it is the same, otherwise it is a conflict.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.serviceUsage.findMany({
          where: { queueEntryId: entry.id, status: 'RECORDED' },
          include: usageInclude,
        });
        const all = planned.map((s) => {
          const row = existing.find((e) => e.serviceId === s.serviceId);
          return row && sameItems(row, s.items)
            ? { serviceId: s.serviceId, usage: toUsageDto(row), created: false }
            : null;
        });
        if (all.every(Boolean))
          return { services: all as RecordServiceUsageResultDto['services'] };
        throw new AppException(
          ServiceUsageErrorCode.ALREADY_RECORDED,
          'Products for this visit were just recorded from another device.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Owner/admin correction: puts the stock back with ADJUSTMENT entries and marks the usage reversed. */
  async reverse(
    userId: string,
    salonId: string,
    usageId: string,
    input: ReverseServiceUsageInput,
  ): Promise<UsageRecordDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const usage = await this.prisma.serviceUsage.findFirst({
      where: { id: usageId, salonId },
      include: { items: true, service: { select: { name: true } } },
    });
    if (!usage)
      throw new AppException(
        ServiceUsageErrorCode.NOT_FOUND,
        'That product usage was not found.',
        HttpStatus.NOT_FOUND,
      );
    const reason = input.reason.trim();
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.serviceUsage.updateMany({
        where: { id: usageId, salonId, status: 'RECORDED' },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedByUserId: userId,
          reversalReason: reason,
        },
      });
      if (claim.count === 0)
        throw new AppException(
          ServiceUsageErrorCode.ALREADY_REVERSED,
          'This usage was already corrected.',
          HttpStatus.CONFLICT,
        );
      const ids = usage.items.map((i) => i.productId).sort();
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "inventory_products"
        WHERE "salonId" = ${salonId} AND "id" IN (${Prisma.join(ids)})
        ORDER BY "id" FOR UPDATE
      `);
      for (const item of usage.items) {
        const key = `svc-usage-rev:${item.id}`;
        const movement = await tx.inventoryMovement.create({
          data: {
            salonId,
            productId: item.productId,
            actorUserId: userId,
            kind: 'ADJUSTMENT',
            quantityDelta: item.quantity,
            reason:
              `Correction of ${usage.service.name} usage: ${reason}`.slice(
                0,
                300,
              ),
            reference: `service-usage:${usage.id}`,
            idempotencyKey: key,
            requestHash: createHash('sha256').update(key).digest('hex'),
          },
          select: { id: true },
        });
        await tx.serviceUsageItem.update({
          where: { id: item.id },
          data: { reversalMovementId: movement.id },
        });
      }
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'SERVICE_USAGE_REVERSED',
          entityType: 'ServiceUsage',
          entityId: usageId,
          metadata: { salonId, reason },
        },
      });
    }, TX);
    const saved = await this.prisma.serviceUsage.findUniqueOrThrow({
      where: { id: usageId },
      include: usageInclude,
    });
    return toUsageDto(saved);
  }

  /**
   * On completion: for each service of the visit with nothing recorded yet whose EVERY recipe line
   * is salon-approved for automatic deduction (a default product and the tick box), deduct those
   * defaults. Anything else waits for a person to choose. Failures (e.g. not enough stock) are
   * logged; the visit then shows under "products not recorded".
   */
  async autoRecord(event: ServiceCompletedEvent): Promise<void> {
    const entry = await this.prisma.queueEntry.findUnique({
      where: { id: event.queueEntryId },
      include: visitInclude,
    });
    if (!entry) return;
    const services = visitServices(entry);
    if (!services.length) return;
    const [rules, recorded, products] = await Promise.all([
      this.prisma.serviceProductRule.findMany({
        where: {
          salonId: entry.salonId,
          serviceId: { in: services.map((s) => s.id) },
        },
        select: {
          id: true,
          serviceId: true,
          quantity: true,
          unit: true,
          autoDeduct: true,
          defaultProductId: true,
        },
      }),
      this.prisma.serviceUsage.findMany({
        where: { queueEntryId: entry.id, status: 'RECORDED' },
        select: { serviceId: true },
      }),
      this.prisma.inventoryProduct.findMany({
        where: { salonId: entry.salonId, isActive: true },
        select: { id: true },
      }),
    ]);
    const active = new Set(products.map((p) => p.id));
    const staffId = entry.serviceSessions[0]?.staffId ?? null;
    for (const service of services) {
      if (recorded.some((r) => r.serviceId === service.id)) continue;
      const lines = rules.filter((r) => r.serviceId === service.id);
      if (
        !lines.length ||
        !lines.every(
          (l) =>
            l.autoDeduct &&
            l.defaultProductId &&
            active.has(l.defaultProductId),
        )
      )
        continue;
      try {
        await this.record(
          event.actorUserId,
          entry,
          staffId,
          {
            services: [
              {
                serviceId: service.id,
                items: lines.map((l) => ({
                  productId: l.defaultProductId!,
                  quantity: Number(l.quantity),
                  unit: l.unit,
                  ruleId: l.id,
                })),
              },
            ],
          },
          'AUTO',
        );
      } catch (err) {
        this.logger.warn(
          `Automatic product deduction skipped for ${service.name} (queue entry ${entry.id}): ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
  }

  /**
   * Who may see/record products for a visit: the owner or a delegated admin at any time while the
   * service is in progress or done; a barber only for a visit they are serving or served, and only
   * up to 12 hours after it was completed.
   */
  private async visitAccess(
    userId: string,
    queueEntryId: string,
    purpose: 'view' | 'record',
  ): Promise<{ entry: VisitRow; kind: ActorKind; staffId: string | null }> {
    const entry = await this.prisma.queueEntry.findUnique({
      where: { id: queueEntryId },
      include: visitInclude,
    });
    if (!entry)
      throw new AppException(
        ServiceUsageErrorCode.NOT_FOUND,
        'That visit was not found.',
        HttpStatus.NOT_FOUND,
      );
    const access = await this.salonAccess.assertAccessOrAdminAccess(
      userId,
      entry.salonId,
    );
    const kind: ActorKind =
      access === 'PLATFORM_ADMIN'
        ? 'PLATFORM_ADMIN'
        : ((await this.salonAccess.getActorKind(userId, entry.salonId)) ??
              'STAFF') === 'OWNER'
          ? 'OWNER'
          : 'STAFF';
    let staffId =
      entry.serviceSessions[0]?.staffId ?? entry.assignedStaffId ?? null;
    if (kind === 'STAFF') {
      const me = await this.prisma.salonStaff.findFirst({
        where: { userId, salonId: entry.salonId },
        select: { id: true },
      });
      const mine =
        !!me &&
        (entry.assignedStaffId === me.id ||
          entry.serviceSessions.some((s) => s.staffId === me.id));
      if (!mine)
        throw new AppException(
          ServiceUsageErrorCode.NOT_YOUR_VISIT,
          'You can only record products for a customer you are serving.',
          HttpStatus.FORBIDDEN,
        );
      staffId = me.id;
    }
    if (purpose === 'record') {
      const inService = entry.status === 'IN_SERVICE';
      const done = entry.status === 'COMPLETED';
      const recent =
        done &&
        !!entry.serviceCompletedAt &&
        Date.now() - entry.serviceCompletedAt.getTime() <=
          STAFF_RECORD_WINDOW_MS;
      if (!inService && !(done && (kind !== 'STAFF' || recent)))
        throw new AppException(
          ServiceUsageErrorCode.VISIT_NOT_ACTIVE,
          kind === 'STAFF' && done
            ? 'It is too late to record products for this visit. Ask the owner to record them.'
            : 'Products can only be recorded once the service has started.',
          HttpStatus.CONFLICT,
        );
    }
    return { entry, kind, staffId };
  }

  // ---------- Owner: visits and dashboard ----------

  async listVisits(
    userId: string,
    salonId: string,
    query: ServiceVisitsQuery,
  ): Promise<ServiceVisitsDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const tz = await this.timeZone(salonId);
    const today = dayString(new Date(), tz);
    const to = query.to ?? today;
    const from =
      query.from ??
      dayString(new Date(Date.parse(`${to}T12:00:00Z`) - 6 * 864e5), tz);
    if (from > to)
      throw new AppException(
        ServiceUsageErrorCode.INVALID_RECIPE,
        'The start date must be on or before the end date.',
        HttpStatus.BAD_REQUEST,
      );
    const { start, end } = await this.dayBounds(from, to, tz);
    const entries = await this.prisma.queueEntry.findMany({
      where: {
        salonId,
        status: 'COMPLETED',
        serviceCompletedAt: { gte: start, lt: end },
      },
      include: visitInclude,
      orderBy: { serviceCompletedAt: 'desc' },
      take: 300,
    });
    const [usages, ruleServices] = await Promise.all([
      this.prisma.serviceUsage.findMany({
        where: {
          queueEntryId: { in: entries.map((e) => e.id) },
          status: 'RECORDED',
        },
        include: usageInclude,
      }),
      this.prisma.serviceProductRule.findMany({
        where: { salonId },
        select: { serviceId: true },
        distinct: ['serviceId'],
      }),
    ]);
    const withRecipe = new Set(ruleServices.map((r) => r.serviceId));
    let missingCount = 0;
    const items: ServiceVisitDto[] = [];
    for (const e of entries) {
      const services = visitServices(e).map((s) => {
        const usage = usages.find(
          (u) => u.queueEntryId === e.id && u.serviceId === s.id,
        );
        return {
          serviceId: s.id,
          serviceName: s.name,
          usage: usage ? toUsageDto(usage) : null,
          hasRecipe: withRecipe.has(s.id),
        };
      });
      const missing = services.some((s) => s.hasRecipe && !s.usage);
      if (missing) missingCount += 1;
      if (query.filter === 'missing' && !missing) continue;
      if (query.filter === 'recorded' && !services.some((s) => s.usage))
        continue;
      items.push({
        queueEntryId: e.id,
        tokenNumber: e.tokenNumber,
        customerName: e.contactName ?? null,
        staffName: e.assignedStaff?.displayName ?? null,
        completedAt: e.serviceCompletedAt?.toISOString() ?? null,
        services,
      });
    }
    return { range: { from, to }, items, missingCount };
  }

  async dashboard(
    userId: string,
    salonId: string,
    query: InventoryDashboardQuery,
  ): Promise<InventoryDashboardDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { timezone: true, currency: true },
    });
    const tz = salon?.timezone || DEFAULT_TZ;
    const asOf = query.to ?? dayString(new Date(), tz);
    const first = dayString(
      new Date(Date.parse(`${asOf}T12:00:00Z`) - 29 * 864e5),
      tz,
    );
    const { start, end } = await this.dayBounds(first, asOf, tz);
    const soon = new Date(Date.parse(`${asOf}T00:00:00Z`) + 30 * 864e5);

    const [totals] = await this.prisma.$queryRaw<
      Array<{
        active: bigint;
        low: bigint;
        out: bigint;
        value: Prisma.Decimal | null;
      }>
    >(Prisma.sql`
      SELECT COUNT(*) AS active,
        COUNT(*) FILTER (WHERE "stockOnHand" <= "reorderThreshold" AND "stockOnHand" > 0) AS low,
        COUNT(*) FILTER (WHERE "stockOnHand" <= 0) AS out,
        SUM("stockOnHand" * "averageUnitCost") AS value
      FROM "inventory_products" WHERE "salonId" = ${salonId} AND "isActive" = true
    `);

    const byDay = await this.prisma.$queryRaw<
      Array<{ day: string; value: Prisma.Decimal | null; entries: bigint }>
    >(Prisma.sql`
      SELECT to_char(("recordedAt" AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day,
        SUM(-"quantityDelta" * "averageUnitCostAfter") AS value, COUNT(*) AS entries
      FROM "inventory_movements"
      WHERE "salonId" = ${salonId} AND "kind" = 'CONSUMPTION'
        AND "recordedAt" >= ${start} AND "recordedAt" < ${end}
      GROUP BY 1
    `);

    const [kinds] = await this.prisma.$queryRaw<
      Array<{
        purchase_value: Prisma.Decimal | null;
        purchase_entries: bigint;
        loss_value: Prisma.Decimal | null;
        loss_entries: bigint;
        retail_value: Prisma.Decimal | null;
        retail_entries: bigint;
      }>
    >(Prisma.sql`
      SELECT
        SUM(m."quantityDelta" * m."unitCost") FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')) AS purchase_value,
        COUNT(*) FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')) AS purchase_entries,
        SUM(-m."quantityDelta" * m."averageUnitCostAfter") FILTER (WHERE m."kind"::text IN (${Prisma.join([...LOSS_KINDS])})) AS loss_value,
        COUNT(*) FILTER (WHERE m."kind"::text IN (${Prisma.join([...LOSS_KINDS])})) AS loss_entries,
        SUM(-m."quantityDelta" * m."averageUnitCostAfter") FILTER (WHERE m."kind" = 'CONSUMPTION' AND p."usage" = 'RETAIL') AS retail_value,
        COUNT(*) FILTER (WHERE m."kind" = 'CONSUMPTION' AND p."usage" = 'RETAIL') AS retail_entries
      FROM "inventory_movements" m JOIN "inventory_products" p ON p."id" = m."productId"
      WHERE m."salonId" = ${salonId} AND m."recordedAt" >= ${start} AND m."recordedAt" < ${end}
    `);

    const byService = await this.prisma.$queryRaw<
      Array<{
        serviceId: string;
        serviceName: string;
        visits: bigint;
        value: Prisma.Decimal | null;
      }>
    >(Prisma.sql`
      SELECT u."serviceId", s."name" AS "serviceName", COUNT(DISTINCT u."queueEntryId") AS visits,
        SUM(i."quantity" * m."averageUnitCostAfter") AS value
      FROM "service_usages" u
      JOIN "services" s ON s."id" = u."serviceId"
      JOIN "service_usage_items" i ON i."usageId" = u."id"
      JOIN "inventory_movements" m ON m."id" = i."movementId"
      WHERE u."salonId" = ${salonId} AND u."status" = 'RECORDED'
        AND u."recordedAt" >= ${start} AND u."recordedAt" < ${end}
      GROUP BY u."serviceId", s."name"
      ORDER BY value DESC NULLS LAST
      LIMIT 10
    `);

    const top = await this.prisma.$queryRaw<
      Array<{
        productId: string;
        name: string;
        unit: InventoryUnit;
        quantity: Prisma.Decimal;
        value: Prisma.Decimal | null;
      }>
    >(Prisma.sql`
      SELECT p."id" AS "productId", p."name", p."unit", SUM(-m."quantityDelta") AS quantity,
        SUM(-m."quantityDelta" * m."averageUnitCostAfter") AS value
      FROM "inventory_movements" m JOIN "inventory_products" p ON p."id" = m."productId"
      WHERE m."salonId" = ${salonId} AND m."kind" = 'CONSUMPTION'
        AND m."recordedAt" >= ${start} AND m."recordedAt" < ${end}
      GROUP BY p."id", p."name", p."unit"
      ORDER BY value DESC NULLS LAST, quantity DESC
      LIMIT 8
    `);

    const expiring = await this.prisma.$queryRaw<
      Array<{
        productId: string;
        name: string;
        batchNumber: string | null;
        expiryDate: Date;
        stockOnHand: Prisma.Decimal;
        unit: InventoryUnit;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON (p."id", m."batchNumber", m."expiryDate")
        p."id" AS "productId", p."name", m."batchNumber", m."expiryDate", p."stockOnHand", p."unit"
      FROM "inventory_movements" m JOIN "inventory_products" p ON p."id" = m."productId"
      WHERE m."salonId" = ${salonId} AND m."expiryDate" IS NOT NULL AND m."expiryDate" < ${soon}
        AND m."kind" IN ('OPENING', 'PURCHASE') AND p."isActive" = true AND p."stockOnHand" > 0
      ORDER BY p."id", m."batchNumber", m."expiryDate"
      LIMIT 50
    `);

    const missing = await this.listVisits(userId, salonId, {
      to: asOf,
      filter: 'missing',
    });

    const money = (v: Prisma.Decimal | null | undefined) =>
      (v ?? new Prisma.Decimal(0)).toFixed(2);
    const series: InventoryDashboardDto['usageByDay'] = [];
    for (let i = 29; i >= 0; i -= 1) {
      const day = dayString(
        new Date(Date.parse(`${asOf}T12:00:00Z`) - i * 864e5),
        tz,
      );
      const row = byDay.find((d) => d.day === day);
      series.push({
        day,
        value: money(row?.value),
        entries: Number(row?.entries ?? 0),
      });
    }
    const sum = (days: number) =>
      series
        .slice(-days)
        .reduce((a, d) => a.plus(d.value), new Prisma.Decimal(0))
        .toFixed(2);

    return {
      asOf,
      currency: salon?.currency ?? null,
      totals: {
        activeProducts: Number(totals?.active ?? 0),
        lowStock: Number(totals?.low ?? 0),
        outOfStock: Number(totals?.out ?? 0),
        stockValue: money(totals?.value),
        expiringSoon: expiring.length,
      },
      usageByDay: series,
      usage: { today: sum(1), last7Days: sum(7), last30Days: sum(30) },
      purchases30Days: {
        value: money(kinds?.purchase_value),
        entries: Number(kinds?.purchase_entries ?? 0),
      },
      wastage30Days: {
        value: money(kinds?.loss_value),
        entries: Number(kinds?.loss_entries ?? 0),
      },
      retailOut30Days: {
        value: money(kinds?.retail_value),
        entries: Number(kinds?.retail_entries ?? 0),
      },
      byService30Days: byService.map((s) => ({
        serviceId: s.serviceId,
        serviceName: s.serviceName,
        visits: Number(s.visits),
        value: money(s.value),
      })),
      topProducts30Days: top.map((t) => ({
        productId: t.productId,
        name: t.name,
        quantity: t.quantity.toFixed(3),
        unit: t.unit,
        value: money(t.value),
      })),
      expiring: expiring
        .sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime())
        .slice(0, 20)
        .map((e) => ({
          productId: e.productId,
          name: e.name,
          batchNumber: e.batchNumber,
          expiryDate: e.expiryDate.toISOString().slice(0, 10),
          stockOnHand: e.stockOnHand.toFixed(3),
          unit: e.unit,
        })),
      visitsMissingUsage7Days: missing.missingCount,
    };
  }

  private async timeZone(salonId: string): Promise<string> {
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { timezone: true },
    });
    return salon?.timezone || DEFAULT_TZ;
  }

  /** [start of `from`, start of the day after `to`) in the salon's time zone, as instants. */
  private async dayBounds(
    from: string,
    to: string,
    tz: string,
  ): Promise<{ start: Date; end: Date }> {
    const [row] = await this.prisma.$queryRaw<
      Array<{ start: Date; end: Date }>
    >(
      Prisma.sql`SELECT (${from}::date::timestamp AT TIME ZONE ${tz}) AS start,
        ((${to}::date + 1)::timestamp AT TIME ZONE ${tz}) AS end`,
    );
    return row;
  }
}
