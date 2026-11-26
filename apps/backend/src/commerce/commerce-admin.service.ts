import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  paise,
  rupeesOf,
  taxInside,
  type CommerceListQuery,
  type CommerceListingInput,
  type CommerceReceiptInput,
  type CommerceStockInInput,
} from '@barbercue/shared';
import type { z } from 'zod';
import type {
  commerceCouponSchema,
  commerceGrantSchema,
  commercePoSchema,
  commerceSellerSettingsSchema,
  commerceSupplierProductSchema,
  commerceSupplierPaymentSchema,
  commerceSupplierSchema,
  commerceWarehouseSchema,
  commerceZoneSchema,
} from '@barbercue/shared';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { priceNow } from './commerce-catalog.service';
import { CommerceStockService } from './commerce-stock.service';
import {
  FASTQUE_SELLER_CODE,
  TX_OPTIONS,
  conflict,
  dateOnly,
  fail,
  indiaToday,
  money,
  notFound,
  type Tx,
} from './commerce-support';

/** Orders that count as sales. Undelivered returns and cancellations never do. */
const NOT_SALES = ['CANCELLED', 'RETURNED', 'RETURN_TO_ORIGIN'] as const;

@Injectable()
export class CommerceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: CommerceStockService,
  ) {}

  private audit(
    tx: Tx | PrismaService,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject = {},
  ) {
    return tx.auditLog.create({
      data: { actorUserId, action, entityType, entityId, metadata },
    });
  }
  private range(q: CommerceListQuery) {
    const from = q.from
      ? new Date(`${q.from}T00:00:00+05:30`)
      : new Date(Date.now() - 30 * 86400_000);
    const to = q.to ? new Date(`${q.to}T23:59:59.999+05:30`) : new Date();
    return { gte: from, lte: to };
  }
  private unique<T>(p: Promise<T>, message: string): Promise<T> {
    return p.catch((e: unknown) => {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw conflict('COMMERCE_DUPLICATE', message);
      throw e;
    });
  }

  // ---------- Seller & staff ----------

  fastque() {
    return this.prisma.commerceSeller.findUniqueOrThrow({
      where: { code: FASTQUE_SELLER_CODE },
    });
  }
  async saveSeller(
    input: z.infer<typeof commerceSellerSettingsSchema>,
    by: string,
  ) {
    const s = await this.prisma.commerceSeller.update({
      where: { code: FASTQUE_SELLER_CODE },
      data: input,
    });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_SELLER_UPDATED',
      'CommerceSeller',
      s.id,
    );
    return s;
  }
  async grants() {
    const rows = await this.prisma.commerceStaffGrant.findMany({
      orderBy: [{ userId: 'asc' }, { permission: 'asc' }],
    });
    const users = await this.prisma.user.findMany({
      where: {
        roles: {
          some: {
            salonId: null,
            role: {
              in: ['CO_FOUNDER', 'PLATFORM_VIEWER', 'HR_ADMIN', 'SALES_ADMIN'],
            },
          },
        },
      },
      select: { id: true, email: true, roles: { select: { role: true } } },
      take: 200,
    });
    return users.map((u) => ({
      userId: u.id,
      email: u.email,
      roles: u.roles.map((r) => r.role),
      permissions: rows
        .filter((r) => r.userId === u.id)
        .map((r) => r.permission),
    }));
  }
  async setGrant(input: z.infer<typeof commerceGrantSchema>, by: string) {
    if (input.permission === 'settings')
      throw fail(
        'COMMERCE_GRANT',
        'Settings stay with platform admins and cannot be delegated.',
      );
    const key = { userId: input.userId, permission: input.permission };
    if (input.granted)
      await this.prisma.commerceStaffGrant.upsert({
        where: { userId_permission: key },
        create: { ...key, grantedByUserId: by },
        update: {},
      });
    else await this.prisma.commerceStaffGrant.deleteMany({ where: key });
    await this.audit(
      this.prisma,
      by,
      input.granted ? 'COMMERCE_GRANTED' : 'COMMERCE_GRANT_REMOVED',
      'User',
      input.userId,
      { permission: input.permission },
    );
  }

  // ---------- Products ----------

  /** Catalog products FastQue could list (verified, not test data, not listed yet). */
  catalogSearch(q: string) {
    return this.prisma.globalProduct.findMany({
      where: {
        verificationStatus: 'VERIFIED',
        visibility: 'GLOBAL',
        isTestData: false,
        commerceListings: { none: { seller: { code: FASTQUE_SELLER_CODE } } },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { brand: { contains: q, mode: 'insensitive' } },
                {
                  barcodes: {
                    some: { code: { contains: q.replace(/\D/g, '') || q } },
                  },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        brand: true,
        variantText: true,
        category: true,
        mrp: true,
      },
      orderBy: { name: 'asc' },
      take: 30,
    });
  }

  async listings(q: CommerceListQuery, showCost: boolean) {
    const where: Prisma.CommerceListingWhereInput = {
      seller: { code: FASTQUE_SELLER_CODE },
      ...(q.status
        ? {
            status:
              q.status as Prisma.EnumCommerceListingStatusFilter['equals'],
          }
        : {}),
      ...(q.q
        ? {
            OR: [
              { sku: { contains: q.q, mode: 'insensitive' } },
              {
                globalProduct: {
                  barcodes: { some: { code: { contains: q.q } } },
                },
              },
              {
                globalProduct: { name: { contains: q.q, mode: 'insensitive' } },
              },
              {
                globalProduct: {
                  brand: { contains: q.q, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceListing.count({ where }),
      this.prisma.commerceListing.findMany({
        where,
        include: {
          globalProduct: {
            select: {
              name: true,
              brand: true,
              variantText: true,
              isTestData: true,
              verificationStatus: true,
            },
          },
          batches: {
            select: {
              onHand: true,
              reserved: true,
              unitCost: true,
              expiresOn: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map((r) => {
        const live = r.batches.filter(
          (b) => !b.expiresOn || b.expiresOn > indiaToday(),
        );
        const onHand = live.reduce((n, b) => n + b.onHand, 0);
        const value = live.reduce(
          (n, b) => n + paise(b.unitCost.toFixed(2)) * b.onHand,
          0,
        );
        const cost = onHand ? value / onHand : null;
        const price = paise(priceNow(r));
        const { batches, ...rest } = r;
        void batches;
        return {
          ...rest,
          priceNow: rupeesOf(price),
          onHand,
          available: live.reduce((n, b) => n + b.onHand - b.reserved, 0),
          ...(showCost
            ? {
                averageCost: cost == null ? null : rupeesOf(Math.round(cost)),
                marginPercent:
                  cost == null
                    ? null
                    : (((price - cost) / price) * 100).toFixed(1),
              }
            : {}),
        };
      }),
    };
  }

  async saveListing(
    id: string | null,
    input: CommerceListingInput,
    by: string,
  ) {
    const { confirmBelowCost, ...data } = input;
    const product = await this.prisma.globalProduct.findUnique({
      where: { id: input.globalProductId },
    });
    if (!product) throw notFound('The catalog product');
    if (
      input.status === 'ACTIVE' &&
      (product.verificationStatus !== 'VERIFIED' ||
        product.visibility !== 'GLOBAL' ||
        product.isTestData)
    )
      throw conflict(
        'COMMERCE_LISTING',
        'Only verified, non-test catalog products can be sold.',
      );
    if (id && !confirmBelowCost) {
      const worst = await this.prisma.commerceBatch.aggregate({
        where: { listingId: id, onHand: { gt: 0 } },
        _max: { unitCost: true },
      });
      const lowest = Math.min(
        paise(input.price),
        input.promoPrice ? paise(input.promoPrice) : Infinity,
      );
      if (worst._max.unitCost && lowest < paise(worst._max.unitCost.toFixed(2)))
        throw conflict(
          'COMMERCE_BELOW_COST',
          `This sells below cost (₹${money(worst._max.unitCost)}). Confirm to continue.`,
        );
    }
    const values = {
      ...data,
      promoPrice: data.promoPrice ?? null,
      promoStartsAt: data.promoStartsAt ? new Date(data.promoStartsAt) : null,
      promoEndsAt: data.promoEndsAt ? new Date(data.promoEndsAt) : null,
    };
    const seller = await this.fastque();
    return this.unique(
      this.prisma.$transaction(async (tx) => {
        if (id) {
          const old = await tx.commerceListing.findUnique({ where: { id } });
          if (!old) throw notFound('The product');
          if (old.globalProductId !== input.globalProductId)
            throw conflict(
              'COMMERCE_LISTING',
              'A listing cannot be moved to another product.',
            );
        }
        const row = id
          ? await tx.commerceListing.update({ where: { id }, data: values })
          : await tx.commerceListing.create({
              data: { ...values, sellerId: seller.id },
            });
        await this.audit(
          tx,
          by,
          id ? 'COMMERCE_LISTING_UPDATED' : 'COMMERCE_LISTING_CREATED',
          'CommerceListing',
          row.id,
          {
            price: money(row.price),
            status: row.status,
            belowCostConfirmed: !!confirmBelowCost,
          },
        );
        return row;
      }),
      'This product is already listed, or the SKU is used by another product.',
    );
  }

  // ---------- Warehouses, stock ----------

  warehouses() {
    return this.prisma.commerceWarehouse.findMany({ orderBy: { code: 'asc' } });
  }
  async saveWarehouse(
    id: string | null,
    input: z.infer<typeof commerceWarehouseSchema>,
    by: string,
  ) {
    const row = await this.unique(
      id
        ? this.prisma.commerceWarehouse.update({ where: { id }, data: input })
        : this.prisma.commerceWarehouse.create({ data: input }),
      'This warehouse code is already used.',
    );
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_WAREHOUSE_SAVED',
      'CommerceWarehouse',
      row.id,
    );
    return row;
  }
  async batches(
    q: CommerceListQuery,
    showCost: boolean,
    warehouseIds: string[] | null = null,
  ) {
    const soon = new Date(indiaToday().getTime() + 90 * 86400_000);
    const where: Prisma.CommerceBatchWhereInput = {
      ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
      ...(q.q
        ? {
            OR: [
              { batchNumber: { contains: q.q, mode: 'insensitive' } },
              { listing: { sku: { contains: q.q, mode: 'insensitive' } } },
              {
                listing: {
                  globalProduct: {
                    name: { contains: q.q, mode: 'insensitive' },
                  },
                },
              },
              {
                listing: {
                  globalProduct: {
                    barcodes: { some: { code: { contains: q.q } } },
                  },
                },
              },
            ],
          }
        : {}),
      ...(q.status === 'NEAR_EXPIRY'
        ? { onHand: { gt: 0 }, expiresOn: { lte: soon } }
        : q.status === 'QUARANTINE'
          ? { quarantined: { gt: 0 } }
          : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceBatch.count({ where }),
      this.prisma.commerceBatch.findMany({
        where,
        include: {
          warehouse: { select: { code: true } },
          listing: {
            select: {
              sku: true,
              globalProduct: { select: { name: true, brand: true } },
            },
          },
        },
        orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map(({ unitCost, supplierId, ...r }) => ({
        ...r,
        ...(showCost ? { unitCost: money(unitCost), supplierId } : {}),
      })),
    };
  }
  movements(batchId: string) {
    return this.prisma.commerceStockMovement.findMany({
      where: { batchId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async openingStock(input: CommerceStockInInput, by: string, key: string) {
    return this.prisma.$transaction(async (tx) => {
      const done = await tx.commerceStockMovement.findUnique({
        where: { idempotencyKey: key },
        include: { batch: true },
      });
      if (done) return done.batch;
      const b = await this.stock.stockIn(tx, input, 'OPENING', by, {
        idempotencyKey: key,
      });
      await this.audit(
        tx,
        by,
        'COMMERCE_STOCK_OPENING',
        'CommerceBatch',
        b.id,
        {
          quantity: input.quantity,
        },
      );
      return b;
    }, TX_OPTIONS);
  }

  // ---------- Delivery zones, coupons ----------

  zones() {
    return this.prisma.commerceZone.findMany({
      include: { warehouse: { select: { code: true, name: true } } },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });
  }
  async saveZone(
    id: string | null,
    input: z.infer<typeof commerceZoneSchema>,
    by: string,
  ) {
    const data = {
      ...input,
      freeAbove: input.freeAbove ?? null,
      maxCodAmount: input.maxCodAmount ?? null,
      minOrderAmount: input.minOrderAmount ?? null,
      maxWeightGrams: input.maxWeightGrams ?? null,
    };
    const row = id
      ? await this.prisma.commerceZone.update({ where: { id }, data })
      : await this.prisma.commerceZone.create({ data });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_ZONE_SAVED',
      'CommerceZone',
      row.id,
      {
        rules: row.pinRules.length,
      },
    );
    return row;
  }
  async coupons() {
    const rows = await this.prisma.commerceCoupon.findMany({
      include: { _count: { select: { uses: { where: { released: false } } } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map(({ _count, ...r }) => ({ ...r, used: _count.uses }));
  }
  async saveCoupon(
    id: string | null,
    input: z.infer<typeof commerceCouponSchema>,
    by: string,
  ) {
    const data = {
      ...input,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
    };
    const row = await this.unique(
      id
        ? this.prisma.commerceCoupon.update({ where: { id }, data })
        : this.prisma.commerceCoupon.create({ data }),
      'This coupon code already exists.',
    );
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_COUPON_SAVED',
      'CommerceCoupon',
      row.id,
    );
    return row;
  }

  // ---------- Orders (lists) ----------

  async orders(q: CommerceListQuery) {
    const where: Prisma.CommerceOrderWhereInput = {
      ...(q.status
        ? { status: q.status as Prisma.EnumCommerceOrderStatusFilter['equals'] }
        : {}),
      ...(q.from || q.to ? { placedAt: this.range(q) } : {}),
      ...(q.q
        ? {
            OR: [
              { orderNumber: { contains: q.q.toUpperCase() } },
              { contactPhone: { contains: q.q.replace(/\D/g, '') || q.q } },
              { contactName: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.commerceOrder.count({ where }),
      this.prisma.commerceOrder.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          contactName: true,
          contactPhone: true,
          total: true,
          placedAt: true,
          shippingAddress: true,
          _count: { select: { items: true } },
        },
        orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { total, page: q.page, pageSize: q.limit, items };
  }

  async cod(q: CommerceListQuery) {
    const where: Prisma.CommerceOrderWhereInput = {
      status: 'DELIVERED',
      ...(q.status
        ? {
            paymentStatus:
              q.status as Prisma.EnumCommercePaymentStatusFilter['equals'],
          }
        : {}),
      ...(q.q ? { orderNumber: { contains: q.q.toUpperCase() } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.commerceOrder.count({ where }),
      this.prisma.commerceOrder.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          total: true,
          paymentStatus: true,
          deliveredAt: true,
          shipments: { select: { courier: true }, take: 1 },
          codEntries: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { deliveredAt: 'asc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map((r) => {
        const sum = (kind: string, f: 'amount' | 'deductions' = 'amount') =>
          r.codEntries
            .filter((e) => e.kind === kind)
            .reduce((n, e) => n + paise(e[f].toFixed(2)), 0);
        const due = paise(r.total.toFixed(2));
        const settled = sum('SETTLED');
        const deductions = sum('SETTLED', 'deductions');
        return {
          id: r.id,
          orderNumber: r.orderNumber,
          courier: r.shipments[0]?.courier ?? null,
          deliveredAt: r.deliveredAt,
          paymentStatus: r.paymentStatus,
          due: rupeesOf(due),
          collected: rupeesOf(sum('COLLECTED')),
          settled: rupeesOf(settled),
          deductions: rupeesOf(deductions),
          netReceived: rupeesOf(settled - deductions),
          adjusted: rupeesOf(sum('ADJUSTMENT')),
          refunded: rupeesOf(sum('REFUND')),
          outstanding: rupeesOf(Math.max(0, due - settled - sum('ADJUSTMENT'))),
          entries: r.codEntries,
        };
      }),
    };
  }

  async returns(q: CommerceListQuery) {
    const where: Prisma.CommerceReturnWhereInput = q.status
      ? { status: q.status as Prisma.EnumCommerceReturnStatusFilter['equals'] }
      : {};
    const [total, items] = await Promise.all([
      this.prisma.commerceReturn.count({ where }),
      this.prisma.commerceReturn.findMany({
        where,
        include: {
          order: {
            select: {
              orderNumber: true,
              contactName: true,
              contactPhone: true,
            },
          },
          items: {
            include: {
              orderItem: { select: { productName: true, unitPrice: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return { total, page: q.page, pageSize: q.limit, items };
  }

  // ---------- Suppliers & procurement ----------

  async suppliers() {
    const rows = await this.prisma.commerceSupplier.findMany({
      include: {
        products: {
          include: {
            listing: {
              select: { sku: true, globalProduct: { select: { name: true } } },
            },
          },
        },
        payments: { select: { amount: true } },
        orders: { include: { items: true } },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    const credits = new Map(
      (
        await this.prisma.commerceSupplierReturn.groupBy({
          by: ['supplierId'],
          where: { status: 'CREDITED' },
          _sum: { creditAmount: true },
        })
      ).map((c) => [c.supplierId, paise(money(c._sum.creditAmount))]),
    );
    return rows.map(({ payments, orders, ...s }) => {
      const items = orders.flatMap((o) => o.items);
      const billed = items.reduce(
        (n, i) => n + paise(i.unitCost.toFixed(2)) * i.accepted,
        0,
      );
      const paid = payments.reduce((n, p) => n + paise(p.amount.toFixed(2)), 0);
      const ordered = orders
        .filter((o) =>
          ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(o.status),
        )
        .flatMap((o) => o.items)
        .reduce((n, i) => n + i.quantity, 0);
      const accepted = items.reduce((n, i) => n + i.accepted, 0);
      const rejected = items.reduce((n, i) => n + i.rejected, 0);
      return {
        ...s,
        billed: rupeesOf(billed),
        paid: rupeesOf(paid),
        credited: rupeesOf(credits.get(s.id) ?? 0),
        outstanding: rupeesOf(billed - paid - (credits.get(s.id) ?? 0)),
        fulfilmentRate: ordered
          ? ((accepted / ordered) * 100).toFixed(1)
          : null,
        rejectionRate:
          accepted + rejected
            ? ((rejected / (accepted + rejected)) * 100).toFixed(1)
            : null,
      };
    });
  }
  async saveSupplier(
    id: string | null,
    input: z.infer<typeof commerceSupplierSchema>,
    by: string,
  ) {
    const row = await this.unique(
      id
        ? this.prisma.commerceSupplier.update({ where: { id }, data: input })
        : this.prisma.commerceSupplier.create({ data: input }),
      'A supplier with this name already exists.',
    );
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_SUPPLIER_SAVED',
      'CommerceSupplier',
      row.id,
    );
    return row;
  }
  saveSupplierProduct(
    supplierId: string,
    input: z.infer<typeof commerceSupplierProductSchema>,
  ) {
    const key = { supplierId, listingId: input.listingId };
    return this.prisma.commerceSupplierProduct.upsert({
      where: { supplierId_listingId: key },
      create: { ...key, unitCost: input.unitCost, minQty: input.minQty },
      update: { unitCost: input.unitCost, minQty: input.minQty },
    });
  }
  async paySupplier(
    supplierId: string,
    input: z.infer<typeof commerceSupplierPaymentSchema>,
    by: string,
    key: string,
  ) {
    const done = await this.prisma.commerceSupplierPayment.findUnique({
      where: { idempotencyKey: key },
    });
    if (done) return done;
    if (input.poId) {
      const po = await this.prisma.commercePurchaseOrder.findFirst({
        where: { id: input.poId, supplierId },
      });
      if (!po) throw notFound('The purchase order');
    }
    const row = await this.prisma.commerceSupplierPayment.create({
      data: {
        supplierId,
        poId: input.poId ?? null,
        amount: input.amount,
        paidOn: dateOnly(input.paidOn),
        reference: input.reference ?? null,
        actorUserId: by,
        idempotencyKey: key,
      },
    });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_SUPPLIER_PAID',
      'CommerceSupplier',
      supplierId,
      {
        amount: input.amount,
      },
    );
    return row;
  }
  async purchaseOrders(q: CommerceListQuery) {
    const where: Prisma.CommercePurchaseOrderWhereInput = q.status
      ? { status: q.status as Prisma.EnumCommercePoStatusFilter['equals'] }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.commercePurchaseOrder.count({ where }),
      this.prisma.commercePurchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          items: {
            include: {
              listing: {
                select: {
                  sku: true,
                  expiryTracked: true,
                  globalProduct: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: q.limit,
      items: rows.map((r) => ({
        ...r,
        total: rupeesOf(
          r.items.reduce(
            (n, i) => n + paise(i.unitCost.toFixed(2)) * i.quantity,
            0,
          ),
        ),
      })),
    };
  }
  async createPo(input: z.infer<typeof commercePoSchema>, by: string) {
    const row = await this.prisma.commercePurchaseOrder.create({
      data: {
        number: `FQPO-${randomBytes(4).toString('hex').toUpperCase()}`,
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        expectedOn: input.expectedOn ? dateOnly(input.expectedOn) : null,
        note: input.note ?? null,
        createdByUserId: by,
        items: { create: input.items },
      },
    });
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_PO_CREATED',
      'CommercePurchaseOrder',
      row.id,
    );
    return row;
  }
  async actOnPo(
    id: string,
    action: 'APPROVE' | 'ORDER' | 'CANCEL',
    by: string,
  ) {
    const from = {
      APPROVE: ['DRAFT'],
      ORDER: ['APPROVED'],
      CANCEL: ['DRAFT', 'APPROVED', 'ORDERED'],
    }[action];
    const po = await this.prisma.commercePurchaseOrder.findUnique({
      where: { id },
    });
    if (!po) throw notFound('The purchase order');
    const res = await this.prisma.commercePurchaseOrder.updateMany({
      where: {
        id,
        status: { in: from as ('DRAFT' | 'APPROVED' | 'ORDERED')[] },
      },
      data:
        action === 'APPROVE'
          ? { status: 'APPROVED', approvedByUserId: by }
          : action === 'ORDER'
            ? { status: 'ORDERED', orderedAt: new Date() }
            : { status: 'CANCELLED' },
    });
    if (!res.count)
      throw conflict(
        'COMMERCE_PO',
        `A ${po.status.toLowerCase()} purchase order cannot be changed this way.`,
      );
    await this.audit(
      this.prisma,
      by,
      `COMMERCE_PO_${action}`,
      'CommercePurchaseOrder',
      id,
    );
  }
  /** Goods receipt with quality check: only accepted units become stock; rejected ones never do. */
  async receive(
    id: string,
    input: CommerceReceiptInput,
    by: string,
    key: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "commerce_purchase_orders" WHERE "id" = ${id}::uuid FOR UPDATE`,
      );
      const po = await tx.commercePurchaseOrder.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!po) throw notFound('The purchase order');
      const firstKey = `${key}:0`;
      if (
        await tx.commerceStockMovement.findUnique({
          where: { idempotencyKey: firstKey },
        })
      )
        return po;
      if (!['ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status))
        throw conflict(
          'COMMERCE_PO',
          'Only an ordered purchase order can be received.',
        );
      if (input.lines.every((l) => l.accepted === 0 && l.rejected === 0))
        throw fail('COMMERCE_PO', 'Enter the quantities received.');
      let n = 0;
      for (const line of input.lines) {
        const item = po.items.find((i) => i.id === line.poItemId);
        if (!item) throw notFound('The purchase order line');
        const fresh = await tx.commercePoItem.findUniqueOrThrow({
          where: { id: item.id },
        });
        if (fresh.accepted + line.accepted > fresh.quantity)
          throw conflict(
            'COMMERCE_PO',
            `Only ${fresh.quantity - fresh.accepted} unit(s) are still expected on this line.`,
          );
        if (line.accepted > 0)
          await this.stock.stockIn(
            tx,
            {
              listingId: item.listingId,
              warehouseId: po.warehouseId,
              batchNumber: line.batchNumber,
              manufacturedOn: line.manufacturedOn,
              expiresOn: line.expiresOn,
              unitCost: money(item.unitCost),
              quantity: line.accepted,
              note: `Purchase ${po.number}`,
            },
            'PURCHASE',
            by,
            {
              reference: po.number,
              idempotencyKey: `${key}:${n++}`,
              supplierId: po.supplierId,
              purchaseOrderId: po.id,
            },
          );
        await tx.commercePoItem.update({
          where: { id: item.id },
          data: {
            accepted: { increment: line.accepted },
            rejected: { increment: line.rejected },
          },
        });
      }
      const items = await tx.commercePoItem.findMany({ where: { poId: id } });
      const complete = items.every((i) => i.accepted >= i.quantity);
      await this.audit(
        tx,
        by,
        'COMMERCE_PO_RECEIVED',
        'CommercePurchaseOrder',
        id,
        {
          lines: input.lines.length,
          complete,
        },
      );
      return tx.commercePurchaseOrder.update({
        where: { id },
        data: {
          status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          ...(input.invoiceNumber
            ? { invoiceNumber: input.invoiceNumber }
            : {}),
        },
      });
    }, TX_OPTIONS);
  }

  // ---------- Analytics ----------

  /**
   * Definitions: GMV = goods + delivery of orders placed (incl. cancelled are excluded). Net revenue =
   * DELIVERED goods after discount, excluding tax, less refunds. Gross profit = net revenue − cost of
   * goods of delivered orders. Contribution = gross profit + delivery charged − courier − COD − packaging.
   * Salon marketplace sales are a separate figure and are never added to FastQue revenue.
   */
  async overview(q: CommerceListQuery, finance: boolean) {
    const placedAt = this.range(q);
    const orders = await this.prisma.commerceOrder.findMany({
      where: { placedAt },
      select: {
        id: true,
        status: true,
        total: true,
        subtotal: true,
        discountTotal: true,
        deliveryCharge: true,
        taxIncluded: true,
        packagingCost: true,
        couponCode: true,
        contactPhone: true,
        placedAt: true,
        shippedAt: true,
        deliveredAt: true,
        shippingAddress: true,
        paymentStatus: true,
        items: {
          select: {
            listingId: true,
            productName: true,
            brand: true,
            category: true,
            quantity: true,
            lineTotal: true,
            costTotal: true,
          },
        },
        shipments: { select: { courierCost: true, codFee: true } },
        codEntries: { select: { kind: true, amount: true } },
      },
      orderBy: { placedAt: 'asc' },
      take: 20000,
    });
    const p = (d: Prisma.Decimal) => paise(d.toFixed(2));
    const count = (...s: string[]) =>
      orders.filter((o) => s.includes(o.status)).length;
    const sales = orders.filter(
      (o) => !(NOT_SALES as readonly string[]).includes(o.status),
    );
    const delivered = orders.filter((o) => o.status === 'DELIVERED');
    const gmv = sales.reduce((n, o) => n + p(o.total), 0);
    const refunds = delivered.reduce(
      (n, o) =>
        n +
        o.codEntries
          .filter((e) => e.kind === 'REFUND')
          .reduce((m, e) => m + p(e.amount), 0),
      0,
    );
    const deliveredGoods = delivered.reduce(
      // A free-delivery coupon is treated as a discount on goods; contribution is the same either way.
      (n, o) => n + p(o.total) - p(o.deliveryCharge),
      0,
    );
    const tax = delivered.reduce((n, o) => n + p(o.taxIncluded), 0);
    const net = deliveredGoods - tax - refunds;
    const cogs = delivered.reduce(
      (n, o) => n + o.items.reduce((m, i) => m + p(i.costTotal), 0),
      0,
    );
    const deliveryIncome = delivered.reduce(
      (n, o) => n + p(o.deliveryCharge),
      0,
    );
    const courier = orders.reduce(
      (n, o) =>
        n + o.shipments.reduce((m, s) => m + p(s.courierCost) + p(s.codFee), 0),
      0,
    );
    const packaging = orders.reduce((n, o) => n + p(o.packagingCost), 0);
    const group = (
      key: (
        o: (typeof sales)[number],
        i: (typeof sales)[number]['items'][number],
      ) => string | null,
    ) => {
      const m = new Map<string, { units: number; sales: number }>();
      for (const o of sales)
        for (const i of o.items) {
          const k = key(o, i) ?? 'Not set';
          const v = m.get(k) ?? { units: 0, sales: 0 };
          v.units += i.quantity;
          v.sales += p(i.lineTotal);
          m.set(k, v);
        }
      return [...m]
        .map(([name, v]) => ({
          name,
          units: v.units,
          sales: rupeesOf(v.sales),
        }))
        .sort((a, b) => Number(b.sales) - Number(a.sales))
        .slice(0, 15);
    };
    const daily = new Map<string, { orders: number; sales: number }>();
    for (const o of sales) {
      const k = new Date(o.placedAt.getTime() + 5.5 * 3600_000)
        .toISOString()
        .slice(0, 10);
      const v = daily.get(k) ?? { orders: 0, sales: 0 };
      v.orders += 1;
      v.sales += p(o.total);
      daily.set(k, v);
    }
    const phones = new Map<string, number>();
    for (const o of sales)
      phones.set(o.contactPhone, (phones.get(o.contactPhone) ?? 0) + 1);
    const before = phones.size
      ? new Set(
          (
            await this.prisma.commerceOrder.findMany({
              where: {
                contactPhone: { in: [...phones.keys()] },
                placedAt: { lt: placedAt.gte },
                status: { notIn: [...NOT_SALES] },
              },
              select: { contactPhone: true },
              distinct: ['contactPhone'],
            })
          ).map((r) => r.contactPhone),
        )
      : new Set<string>();
    const shops = await this.prisma.shopOrder.aggregate({
      where: { placedAt, status: 'COMPLETED' },
      _sum: { total: true },
      _count: true,
    });
    const stockRows = finance
      ? await this.prisma.$queryRaw<Array<{ v: string | null }>>(
          Prisma.sql`SELECT COALESCE(SUM("onHand" * "unitCost"), 0)::text AS v FROM "commerce_batches" WHERE "expiresOn" IS NULL OR "expiresOn" > ${indiaToday()}`,
        )
      : [];
    const outstanding = finance
      ? await this.prisma.commerceOrder.aggregate({
          where: {
            status: 'DELIVERED',
            paymentStatus: {
              in: [
                'COD_PENDING',
                'COD_COLLECTED',
                'SETTLEMENT_PENDING',
                'PARTIALLY_SETTLED',
              ],
            },
          },
          _sum: { total: true },
        })
      : null;
    const hours = (xs: number[]) =>
      xs.length
        ? (xs.reduce((a, b) => a + b, 0) / xs.length / 3600_000).toFixed(1)
        : null;
    return {
      from: placedAt.gte,
      to: placedAt.lte,
      orders: {
        placed: orders.length,
        open: count(
          'PLACED',
          'CONFIRMED',
          'PROCESSING',
          'PACKED',
          'SHIPPED',
          'OUT_FOR_DELIVERY',
          'DELIVERY_FAILED',
        ),
        delivered: delivered.length,
        cancelled: count('CANCELLED'),
        returnedToOrigin: count('RETURN_TO_ORIGIN', 'RETURNED'),
        byStatus: Object.fromEntries(
          [...new Set(orders.map((o) => o.status))].map((s) => [s, count(s)]),
        ),
      },
      gmv: rupeesOf(gmv),
      averageOrder: sales.length
        ? rupeesOf(Math.round(gmv / sales.length))
        : null,
      unitsSold: sales.reduce(
        (n, o) => n + o.items.reduce((m, i) => m + i.quantity, 0),
        0,
      ),
      customers: {
        buying: phones.size,
        repeat: [...phones].filter(([ph, n]) => n > 1 || before.has(ph)).length,
      },
      operations: {
        hoursToShip: hours(
          orders
            .filter((o) => o.shippedAt)
            .map((o) => o.shippedAt!.getTime() - o.placedAt.getTime()),
        ),
        hoursToDeliver: hours(
          delivered
            .filter((o) => o.deliveredAt)
            .map((o) => o.deliveredAt!.getTime() - o.placedAt.getTime()),
        ),
        cancellationRate: orders.length
          ? ((count('CANCELLED') / orders.length) * 100).toFixed(1)
          : null,
        rtoRate: orders.length
          ? (
              (count('RETURN_TO_ORIGIN', 'RETURNED') / orders.length) *
              100
            ).toFixed(1)
          : null,
      },
      daily: [...daily].map(([day, v]) => ({
        day,
        orders: v.orders,
        sales: rupeesOf(v.sales),
      })),
      byProduct: group((_o, i) => i.productName),
      byCategory: group((_o, i) => i.category),
      byBrand: group((_o, i) => i.brand),
      byCity: group(
        (o) => (o.shippingAddress as { city?: string } | null)?.city ?? null,
      ),
      salonMarketplace: {
        completedOrders: shops._count,
        salesAtSalons: money(shops._sum.total),
        note: 'Sold by salons. Not FastQue revenue.',
      },
      finance: finance
        ? {
            netRevenue: rupeesOf(net),
            costOfGoods: rupeesOf(cogs),
            grossProfit: rupeesOf(net - cogs),
            grossMarginPercent:
              net > 0 ? (((net - cogs) / net) * 100).toFixed(1) : null,
            refunds: rupeesOf(refunds),
            deliveryIncome: rupeesOf(deliveryIncome),
            courierAndCodFees: rupeesOf(courier),
            packaging: rupeesOf(packaging),
            contribution: rupeesOf(
              net - cogs + deliveryIncome - courier - packaging,
            ),
            inventoryValue: Number(stockRows[0]?.v ?? 0).toFixed(2),
            codOutstanding: money(outstanding?._sum.total),
            supplierOutstanding: rupeesOf(
              (await this.suppliers()).reduce(
                (n, s) => n + paise(s.outstanding),
                0,
              ),
            ),
          }
        : null,
    };
  }

  // ---------- Insights: transparent rules over recorded data, never invented predictions ----------

  async insights() {
    const since = new Date(Date.now() - 30 * 86400_000);
    const listings = await this.prisma.commerceListing.findMany({
      where: {
        status: { in: ['ACTIVE', 'PAUSED'] },
        seller: { code: FASTQUE_SELLER_CODE },
      },
      include: {
        globalProduct: { select: { name: true } },
        batches: true,
        supplierProducts: { include: { supplier: true } },
        orderItems: {
          where: {
            order: {
              placedAt: { gte: since },
              status: { notIn: [...NOT_SALES] },
            },
          },
          select: { quantity: true },
        },
      },
      take: 2000,
    });
    const today = indiaToday();
    const rows: Array<{
      kind: string;
      product: string;
      message: string;
      basis: string;
    }> = [];
    for (const l of listings) {
      const name = l.globalProduct.name;
      const live = l.batches.filter((b) => !b.expiresOn || b.expiresOn > today);
      const available = live.reduce((n, b) => n + b.onHand - b.reserved, 0);
      const sold = l.orderItems.reduce((n, i) => n + i.quantity, 0);
      const lead =
        Math.min(
          ...l.supplierProducts.map((s) => s.supplier.leadTimeDays ?? 7),
          30,
        ) || 7;
      if (sold >= 5) {
        const perDay = sold / 30;
        const days = Math.floor(available / perDay);
        if (days <= lead + 3)
          rows.push({
            kind: 'REORDER',
            product: name,
            message: `About ${days} day(s) of stock left. Consider ordering ${Math.max(1, Math.ceil(perDay * (lead + 14) + l.safetyStock - available))}.`,
            basis: `${sold} sold in 30 days, ${available} available, ${lead}-day lead time.`,
          });
      } else if (available <= l.reorderLevel && l.reorderLevel > 0)
        rows.push({
          kind: 'LOW_STOCK',
          product: name,
          message: `${available} available, at or below the reorder level of ${l.reorderLevel}.`,
          basis:
            'Reorder level set on the product. Not enough sales yet for a forecast.',
        });
      const oldest = live.length
        ? Math.min(...live.map((b) => b.createdAt.getTime()))
        : Infinity;
      if (available > 0 && sold === 0 && oldest < since.getTime())
        rows.push({
          kind: 'SLOW_MOVING',
          product: name,
          message: `No sales in 30 days with ${available} in stock.`,
          basis: 'Orders placed in the last 30 days.',
        });
      for (const b of live)
        if (
          b.onHand > 0 &&
          b.expiresOn &&
          b.expiresOn.getTime() - today.getTime() <= 60 * 86400_000
        )
          rows.push({
            kind: 'NEAR_EXPIRY',
            product: name,
            message: `${b.onHand} unit(s) of batch ${b.batchNumber} expire on ${b.expiresOn.toISOString().slice(0, 10)}. Consider a clearance price.`,
            basis: 'Batch expiry date.',
          });
      const cost = live
        .filter((b) => b.onHand > 0)
        .map((b) => Number(b.unitCost));
      const price = Number(priceNow(l));
      if (cost.length) {
        const margin = ((price - Math.max(...cost)) / price) * 100;
        if (margin < 10)
          rows.push({
            kind: 'LOW_MARGIN',
            product: name,
            message: `Margin is ${margin.toFixed(1)}% on the costliest batch in stock.`,
            basis: `Price ₹${price.toFixed(2)}, cost ₹${Math.max(...cost).toFixed(2)} (before delivery).`,
          });
      }
      const quotes = [...l.supplierProducts].sort(
        (a, b) => Number(a.unitCost) - Number(b.unitCost),
      );
      if (
        quotes.length > 1 &&
        Number(quotes[1].unitCost) > Number(quotes[0].unitCost)
      )
        rows.push({
          kind: 'SUPPLIER',
          product: name,
          message: `${quotes[0].supplier.name} quotes the lowest price: ₹${money(quotes[0].unitCost)} (next ₹${money(quotes[1].unitCost)}).`,
          basis: `${quotes.length} supplier prices on file.`,
        });
    }
    const risky = await this.prisma.$queryRaw<
      Array<{ phone: string; orders: bigint; bad: bigint }>
    >(Prisma.sql`
      SELECT "contactPhone" AS phone, count(*) AS orders,
             count(*) FILTER (WHERE "status" IN ('CANCELLED','RETURN_TO_ORIGIN','RETURNED')) AS bad
      FROM "commerce_orders" WHERE "placedAt" > now() - interval '90 days'
      GROUP BY 1 HAVING count(*) FILTER (WHERE "status" IN ('CANCELLED','RETURN_TO_ORIGIN','RETURNED')) >= 3
      ORDER BY 3 DESC LIMIT 20`);
    for (const r of risky)
      rows.push({
        kind: 'COD_RISK',
        product: `Phone ending ${r.phone.slice(-4)}`,
        message: `${r.bad} of ${r.orders} orders were cancelled or refused. Call before shipping.`,
        basis:
          'Orders in the last 90 days. A person decides; nothing is blocked automatically.',
      });
    return rows;
  }

  // ---------- Data quality ----------

  async dataQuality() {
    const suspect = await this.prisma.globalProduct.findMany({
      where: {
        isTestData: false,
        OR: [
          ...['mock', 'test', 'sample', 'demo'].map((w) => ({
            brand: { contains: w, mode: 'insensitive' as const },
          })),
          { externalRef: { contains: 'TST', mode: 'insensitive' } },
          { sourceReference: { contains: 'test', mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        name: true,
        brand: true,
        externalRef: true,
        sourceReference: true,
        dataSource: true,
      },
      orderBy: [{ brand: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    const verified = {
      verificationStatus: 'VERIFIED' as const,
      isTestData: false,
    };
    const [
      noSeller,
      noImage,
      noDescription,
      noBarcode,
      listedNoStock,
      unapproved,
      expired,
    ] = await Promise.all([
      this.prisma.globalProduct.count({
        where: {
          ...verified,
          commerceListings: { none: { status: 'ACTIVE' } },
          shopListings: { none: { status: 'APPROVED' } },
        },
      }),
      this.prisma.globalProduct.count({
        where: { ...verified, images: { none: {} } },
      }),
      this.prisma.globalProduct.count({
        where: {
          ...verified,
          OR: [{ description: null }, { description: '' }],
        },
      }),
      this.prisma.globalProduct.count({
        where: { ...verified, barcodes: { none: {} } },
      }),
      this.prisma.commerceListing.count({
        where: { status: 'ACTIVE', batches: { none: { onHand: { gt: 0 } } } },
      }),
      this.prisma.shopListing.count({ where: { status: 'PENDING_APPROVAL' } }),
      this.prisma.commerceBatch.count({
        where: { onHand: { gt: 0 }, expiresOn: { lte: indiaToday() } },
      }),
    ]);
    const markedTest = await this.prisma.globalProduct.count({
      where: { isTestData: true },
    });
    return {
      counts: {
        noSeller,
        noImage,
        noDescription,
        noBarcode,
        listedNoStock,
        unapprovedSalonListings: unapproved,
        expiredStillOnHand: expired,
        markedTest,
      },
      suspect,
    };
  }
  /** Reversible and audited: only flips the existing test-data marker; nothing is deleted. */
  async markTestData(ids: string[], isTestData: boolean, by: string) {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.globalProduct.updateMany({
        where: { id: { in: ids }, isTestData: !isTestData },
        data: { isTestData },
      });
      await this.audit(
        tx,
        by,
        'COMMERCE_TEST_DATA_MARKED',
        'GlobalProduct',
        ids[0],
        {
          ids,
          isTestData,
          changed: res.count,
        },
      );
      return { changed: res.count };
    });
  }

  // ---------- Documents & exports ----------

  async invoice(orderId: string) {
    const o = await this.prisma.commerceOrder.findUnique({
      where: { id: orderId },
      include: { items: true, seller: true },
    });
    if (!o) throw notFound('The order');
    return {
      orderNumber: o.orderNumber,
      placedAt: o.placedAt,
      seller: {
        name: o.sellerName,
        legalName: o.seller.legalName,
        gstin: o.seller.gstin,
        address: o.seller.address,
      },
      billTo: o.billingAddress ?? o.shippingAddress,
      items: o.items.map((i) => ({
        name: i.productName,
        hsn: i.hsnCode,
        quantity: i.quantity,
        unitPrice: money(i.unitPrice),
        lineTotal: money(i.lineTotal),
        gstRate: i.gstRatePercent?.toFixed(2) ?? null,
        taxInLine: rupeesOf(
          taxInside(
            paise(i.lineTotal.toFixed(2)),
            Number(i.gstRatePercent ?? 0),
          ),
        ),
      })),
      subtotal: money(o.subtotal),
      discount: money(o.discountTotal),
      delivery: money(o.deliveryCharge),
      taxIncluded: money(o.taxIncluded),
      total: money(o.total),
      /** A GST tax invoice needs the seller's GSTIN and legal name to be filled in under Settings. */
      taxInvoiceReady: !!(
        o.seller.gstin &&
        o.seller.legalName &&
        o.seller.address
      ),
    };
  }

  async exportOrders(q: CommerceListQuery, finance: boolean) {
    const rows = await this.prisma.commerceOrder.findMany({
      where: { placedAt: this.range(q) },
      include: { items: true },
      orderBy: { placedAt: 'asc' },
      take: 20000,
    });
    return rows.map((o) => ({
      order: o.orderNumber,
      placed: o.placedAt,
      status: o.status,
      payment: o.paymentStatus,
      customer: o.contactName,
      phone: o.contactPhone,
      city: (o.shippingAddress as { city?: string }).city ?? '',
      pincode: (o.shippingAddress as { pincode?: string }).pincode ?? '',
      items: o.items.map((i) => `${i.quantity}x ${i.productName}`).join('; '),
      subtotal: money(o.subtotal),
      discount: money(o.discountTotal),
      delivery: money(o.deliveryCharge),
      total: money(o.total),
      ...(finance
        ? {
            cost: rupeesOf(
              o.items.reduce((n, i) => n + paise(i.costTotal.toFixed(2)), 0),
            ),
          }
        : {}),
    }));
  }
}
