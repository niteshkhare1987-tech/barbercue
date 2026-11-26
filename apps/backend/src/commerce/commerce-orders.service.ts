import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  COMMERCE_PAYMENT_LABEL,
  COMMERCE_RETURN_TRANSITIONS,
  COMMERCE_STATUS_LABEL,
  allowedCommerceTransitions,
  applyPromotions,
  canCommerceTransition,
  couponDiscount,
  paise,
  rupeesOf,
  taxInside,
  type AppliedPromotion,
  type CommerceActor,
  type CommerceAddressInput,
  type CommerceCheckoutInput,
  type CommerceCheckoutResultDto,
  type CommerceCodEntryInput,
  type CommerceOrderDto,
  type CommerceOrderStatus,
  type CommercePaymentStatus,
  type CommerceQuoteDto,
  type CommerceQuoteInput,
  type CommerceReturnActionInput,
  type CommerceReturnRequestInput,
  type CommerceTransitionInput,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ShopOrderService } from '../shop/shop-order.service';
import {
  CommerceCatalogService,
  isSellable,
  listingInclude,
  priceNow,
  returnRule,
  returnRules,
} from './commerce-catalog.service';
import { CommerceOutboxService } from './commerce-outbox.service';
import { CommerceStockService } from './commerce-stock.service';
import {
  TX_OPTIONS,
  conflict,
  dateOnly,
  fail,
  flag,
  money,
  normalizePhone,
  notFound,
  sha256,
  type Db,
  type Tx,
} from './commerce-support';

/** One phone number may have this many undelivered COD orders open at once. */
const MAX_OPEN_COD_ORDERS = 5;
const OPEN: CommerceOrderStatus[] = [
  'PLACED',
  'CONFIRMED',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERY_FAILED',
];

const orderInclude = {
  checkout: { select: { number: true } },
  items: {
    orderBy: { productName: 'asc' as const },
    include: { returnItems: { include: { return: true } } },
  },
  events: { orderBy: { createdAt: 'asc' as const } },
  shipments: { orderBy: { createdAt: 'desc' as const } },
  returns: {
    orderBy: { createdAt: 'desc' as const },
    include: { items: true },
  },
} satisfies Prisma.CommerceOrderInclude;
export type CommerceOrderRow = Prisma.CommerceOrderGetPayload<{
  include: typeof orderInclude;
}>;

function orderToken(orderId: string): string {
  const secret =
    process.env.SHOP_ORDER_TOKEN_SECRET || process.env.JWT_ACCESS_SECRET;
  if (!secret)
    throw new Error(
      'SHOP_ORDER_TOKEN_SECRET (or JWT_ACCESS_SECRET) must be set',
    );
  return createHmac('sha256', secret)
    .update(`commerce-order:${orderId}`)
    .digest('base64url');
}
const number = (prefix: string) =>
  `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

/** The offer snapshot stored on an order. */
const promotionsOf = (v: Prisma.JsonValue): AppliedPromotion[] =>
  Array.isArray(v) ? (v as unknown as AppliedPromotion[]) : [];

export function toCommerceOrderDto(
  o: CommerceOrderRow,
  viewer: CommerceActor,
): CommerceOrderDto {
  const addDays = (d: Date, n: number) =>
    new Date(d.getTime() + n * 86400_000).toISOString();
  const s = o.shipments[0];
  const due =
    o.paymentStatus === 'COD_PENDING' && o.status !== 'CANCELLED'
      ? money(o.total)
      : '0.00';
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    checkoutNumber: o.checkout.number,
    sellerName: o.sellerName,
    sellerType: 'FASTQUE',
    status: o.status,
    statusLabel: COMMERCE_STATUS_LABEL[o.status],
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    paymentLabel: COMMERCE_PAYMENT_LABEL[o.paymentStatus],
    contactName: o.contactName,
    contactPhone: o.contactPhone,
    contactEmail: o.contactEmail,
    shippingAddress: o.shippingAddress as unknown as CommerceAddressInput,
    instructions: o.instructions,
    items: o.items.map((i) => {
      const asked = i.returnItems
        .filter((r) => r.return.status !== 'REJECTED')
        .reduce((n, r) => n + r.quantity, 0);
      return {
        id: i.id,
        productId: i.globalProductId,
        name: i.productName,
        brand: i.brand,
        variant: i.variant,
        sku: i.sku,
        hsnCode: i.hsnCode,
        gstRatePercent: i.gstRatePercent?.toFixed(2) ?? null,
        quantity: i.quantity,
        mrp: money(i.mrp),
        unitPrice: money(i.unitPrice),
        lineTotal: money(i.lineTotal),
        returnableUntil:
          i.returnable && o.deliveredAt
            ? addDays(o.deliveredAt, i.returnWindowDays)
            : null,
        returnableQuantity: Math.max(0, i.quantity - asked),
      };
    }),
    subtotal: money(o.subtotal),
    discountTotal: money(o.discountTotal),
    promotions: promotionsOf(o.promotions).map((p) => ({
      name: p.name,
      amount: rupeesOf(p.amountPaise),
    })),
    couponCode: o.couponCode,
    deliveryCharge: money(o.deliveryCharge),
    taxIncluded: money(o.taxIncluded),
    total: money(o.total),
    amountDue: due,
    expectedFrom: addDays(o.placedAt, o.minDays),
    expectedTo: addDays(o.placedAt, o.maxDays),
    placedAt: o.placedAt.toISOString(),
    shippedAt: o.shippedAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    events: o.events.map((e) => ({
      toStatus: e.toStatus,
      label: COMMERCE_STATUS_LABEL[e.toStatus],
      // Staff notes stay internal; customers only see their own.
      note: viewer === 'STAFF' || e.actorKind !== 'STAFF' ? e.note : null,
      at: e.createdAt.toISOString(),
    })),
    shipment: s
      ? {
          courier: s.courier,
          trackingNumber: s.trackingNumber,
          trackingUrl: s.trackingUrl,
          expectedOn: s.expectedOn?.toISOString().slice(0, 10) ?? null,
          manual: s.manual,
        }
      : null,
    returns: o.returns.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      reason: r.reason,
      resolution: r.resolution,
      adminNote: r.adminNote,
      createdAt: r.createdAt.toISOString(),
      items: r.items.map((i) => ({
        id: i.id,
        orderItemId: i.orderItemId,
        quantity: i.quantity,
        disposition: i.disposition,
      })),
    })),
    allowedTransitions: allowedCommerceTransitions(o.status, viewer),
  };
}

@Injectable()
export class CommerceOrdersService {
  private readonly log = new Logger(CommerceOrdersService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CommerceCatalogService,
    private readonly stock: CommerceStockService,
    private readonly outbox: CommerceOutboxService,
    private readonly shopOrders: ShopOrderService,
  ) {}

  // ---------- Quote ----------

  async quote(
    input: CommerceQuoteInput & { phone?: string },
    db: Db = this.prisma,
  ): Promise<
    CommerceQuoteDto & {
      zone: Awaited<ReturnType<CommerceCatalogService['zoneFor']>>;
      couponId: string | null;
      applied: AppliedPromotion[];
    }
  > {
    const merged = new Map<string, number>();
    for (const l of input.items)
      merged.set(l.listingId, (merged.get(l.listingId) ?? 0) + l.quantity);
    const rows = await db.commerceListing.findMany({
      where: { id: { in: [...merged.keys()] } },
      include: listingInclude,
    });
    const blocking: string[] = [];
    if (rows.length < merged.size)
      blocking.push(
        'Some products are no longer sold. Remove them to continue.',
      );
    if (!flag('FASTQUE_COD_ENABLED'))
      blocking.push('Cash on Delivery is not available right now.');
    const zone =
      input.pincode && flag('FASTQUE_DELIVERY_ENABLED')
        ? await this.catalog.zoneFor(input.pincode, db)
        : null;
    const serviceability = input.pincode
      ? await this.catalog.serviceability(input.pincode, db)
      : null;
    if (serviceability && !serviceability.serviceable)
      blocking.push(serviceability.message);
    const available = await this.stock.available(
      db,
      rows.map((r) => r.id),
      zone?.warehouseId,
    );
    let subtotal = 0;
    let savings = 0;
    let weight = 0;
    const lines = rows.map((l) => {
      const quantity = merged.get(l.id)!;
      const have = available.get(l.id) ?? 0;
      let problem: string | null = null;
      if (!isSellable(l)) problem = 'No longer sold by FastQue.';
      else if (!l.codEligible) problem = 'Not available with Cash on Delivery.';
      else if (have <= 0)
        problem = zone ? 'Out of stock for your area.' : 'Out of stock.';
      else if (quantity > have) problem = `Only ${have} left.`;
      else if (quantity > l.maxPerOrder)
        problem = `At most ${l.maxPerOrder} per order.`;
      if (problem) blocking.push(`${l.globalProduct.name}: ${problem}`);
      const unit = paise(priceNow(l));
      subtotal += unit * quantity;
      savings += (paise(l.mrp.toFixed(2)) - unit) * quantity;
      weight += l.weightGrams * quantity;
      return {
        row: l,
        listingId: l.id,
        productId: l.globalProductId,
        name: l.globalProduct.name,
        brand: l.globalProduct.brand,
        variant: l.globalProduct.variantText,
        quantity,
        mrp: l.mrp.toFixed(2),
        unitPrice: rupeesOf(unit),
        lineTotal: rupeesOf(unit * quantity),
        availableQuantity: Math.min(have, l.maxPerOrder),
        maxPerOrder: l.maxPerOrder,
        problem,
      };
    });
    let delivery: number | null = null;
    if (zone) {
      delivery =
        zone.freeAbove && subtotal >= paise(zone.freeAbove.toFixed(2))
          ? 0
          : paise(zone.deliveryCharge.toFixed(2));
      if (
        zone.minOrderAmount &&
        subtotal < paise(zone.minOrderAmount.toFixed(2))
      )
        blocking.push(
          `The minimum order for your area is ₹${money(zone.minOrderAmount)}.`,
        );
      if (zone.maxWeightGrams && weight > zone.maxWeightGrams)
        blocking.push('This order is too heavy to deliver to your area.');
      if (!zone.codEligible)
        blocking.push('Cash on Delivery is not available for your PIN code.');
    }
    const promoRows = await db.commercePromotion.findMany({
      where: {
        isActive: true,
        listingIds: { hasSome: lines.map((l) => l.listingId) },
      },
      take: 200,
    });
    const applied = applyPromotions(
      promoRows.map((p) => ({ ...p, value: p.value.toFixed(2) })),
      lines.map((l) => ({
        listingId: l.listingId,
        quantity: l.quantity,
        unitPaise: paise(l.unitPrice),
      })),
      input.pincode,
      new Date(),
    );
    const offDue = (id: string) =>
      applied.reduce((x, a) => x + (a.perListing[id] ?? 0), 0);
    const promo = applied.reduce((x, a) => x + a.amountPaise, 0);
    // What is left after offers; coupons and their minimum work on this.
    const goods = subtotal - promo;
    const coupon = input.couponCode
      ? await this.applyCoupon(
          db,
          input.couponCode,
          lines.map((l) => ({
            brand: l.brand,
            category: l.row.globalProduct.category,
            total: paise(l.lineTotal) - offDue(l.listingId),
          })),
          goods,
          delivery ?? 0,
          input.phone,
        )
      : null;
    const discount = promo + (coupon?.discount ?? 0);
    if (
      zone?.maxCodAmount &&
      subtotal - discount + (delivery ?? 0) >
        paise(zone.maxCodAmount.toFixed(2))
    )
      blocking.push(
        `Cash on Delivery is limited to ₹${money(zone.maxCodAmount)} for your area.`,
      );
    const goodsDiscount = coupon?.freeDelivery ? 0 : (coupon?.discount ?? 0);
    const tax = lines.reduce((n, l) => {
      const total = paise(l.lineTotal) - offDue(l.listingId);
      const net =
        goods > 0 ? total - Math.round((goodsDiscount * total) / goods) : 0;
      return (
        n + taxInside(net, Number(l.row.globalProduct.gstRatePercent ?? 0))
      );
    }, 0);
    return {
      lines: lines.map(({ row, ...l }) => {
        void row;
        return l;
      }),
      subtotal: rupeesOf(subtotal),
      savings: rupeesOf(Math.max(0, savings)),
      discountTotal: rupeesOf(discount),
      promotions: applied.map((a) => ({
        name: a.name,
        amount: rupeesOf(a.amountPaise),
      })),
      couponCode: coupon?.code ?? null,
      couponMessage: coupon?.message ?? null,
      deliveryCharge: delivery == null ? null : rupeesOf(delivery),
      taxIncluded: rupeesOf(tax),
      total: rupeesOf(subtotal - discount + (delivery ?? 0)),
      serviceability,
      blocking: [...new Set(blocking)],
      zone,
      couponId: coupon?.id ?? null,
      applied,
    };
  }

  publicQuote = async (
    input: CommerceQuoteInput,
  ): Promise<CommerceQuoteDto> => {
    const { zone, couponId, applied, ...dto } = await this.quote(input);
    void zone;
    void couponId;
    void applied;
    return dto;
  };

  private async applyCoupon(
    db: Db,
    raw: string,
    lines: Array<{
      brand: string | null;
      category: string | null;
      total: number;
    }>,
    subtotal: number,
    delivery: number,
    phone?: string,
  ) {
    const no = (message: string) => ({
      id: null,
      code: null,
      discount: 0,
      freeDelivery: false,
      message,
    });
    const c = await db.commerceCoupon.findUnique({
      where: { code: raw.trim().toUpperCase() },
    });
    const now = new Date();
    if (
      !c?.isActive ||
      (c.startsAt && now < c.startsAt) ||
      (c.endsAt && now >= c.endsAt)
    )
      return no('This coupon is not valid.');
    if (subtotal < paise(c.minOrder.toFixed(2)))
      return no(`Add products worth ₹${money(c.minOrder)} to use this coupon.`);
    const same = (a: string | null, b: string | null) =>
      !b || a?.toLowerCase() === b.toLowerCase();
    const eligible = lines
      .filter((l) => same(l.brand, c.brand) && same(l.category, c.category))
      .reduce((n, l) => n + l.total, 0);
    if (!eligible) return no('This coupon does not apply to these products.');
    if (
      c.usageLimit &&
      (await db.commerceCouponUse.count({
        where: { couponId: c.id, released: false },
      })) >= c.usageLimit
    )
      return no('This coupon has been fully used.');
    if (phone) {
      if (
        (await db.commerceCouponUse.count({
          where: { couponId: c.id, phone, released: false },
        })) >= c.perCustomer
      )
        return no('You have already used this coupon.');
      if (
        c.firstOrderOnly &&
        (await db.commerceOrder.count({
          where: { contactPhone: phone, status: { not: 'CANCELLED' } },
        }))
      )
        return no('This coupon is for a first order.');
    }
    return {
      id: c.id,
      code: c.code,
      freeDelivery: c.kind === 'FREE_DELIVERY',
      discount: couponDiscount(
        {
          kind: c.kind,
          value: c.value.toFixed(2),
          maxDiscount: c.maxDiscount?.toFixed(2) ?? null,
          minOrder: c.minOrder.toFixed(2),
        },
        eligible,
        delivery,
      ),
      message: c.description ?? 'Coupon applied.',
    };
  }

  // ---------- Checkout ----------

  /**
   * One checkout, independent orders per seller. Everything is validated before anything is placed;
   * if a salon order still fails, the orders already placed are cancelled and the customer is told,
   * so a checkout is never silently half-placed. Retrying with the same key resumes or replays it.
   */
  async checkout(
    input: CommerceCheckoutInput,
    rawKey: string | undefined,
    customerUserId: string | null,
  ): Promise<CommerceCheckoutResultDto> {
    const key = rawKey?.trim();
    if (!key || !/^[A-Za-z0-9_:-]{8,80}$/.test(key))
      throw fail(
        'IDEMPOTENCY_KEY_REQUIRED',
        'An Idempotency-Key header (8–80 letters, digits, - _ :) is required.',
      );
    if (input.salons.length && !flag('MULTI_SELLER_CART_ENABLED'))
      throw conflict(
        'COMMERCE_MULTI_SELLER_DISABLED',
        'Check out FastQue and salon products separately.',
      );
    const hash = sha256(JSON.stringify([customerUserId, input]));
    const existing = await this.prisma.commerceCheckout.findUnique({
      where: { idempotencyKey: key },
    });
    if (existing) {
      if (
        existing.requestHash !== hash ||
        existing.customerUserId !== customerUserId
      )
        throw conflict(
          'COMMERCE_IDEMPOTENCY_CONFLICT',
          'This checkout key was already used.',
        );
      const r = existing.result as unknown as
        (CommerceCheckoutResultDto & { failed?: string }) | null;
      if (r?.failed) throw conflict('COMMERCE_CHECKOUT_FAILED', r.failed);
      if (r) return this.replay(r);
    } else await this.preflight(input);

    const checkoutId =
      existing?.id ?? (await this.createCheckout(key, hash, customerUserId)).id;
    const placed: Array<() => Promise<unknown>> = [];
    try {
      let fastque: CommerceCheckoutResultDto['fastque'] = null;
      if (input.fastque) {
        const o = await this.placeFastque(checkoutId, input, customerUserId);
        placed.push(() =>
          this.transition(
            o.id,
            { to: 'CANCELLED', note: 'Checkout could not be completed' },
            'CUSTOMER',
            customerUserId,
          ),
        );
        fastque = {
          orderNumber: o.orderNumber,
          accessToken: orderToken(o.id),
          total: money(o.total),
        };
      }
      const salons: CommerceCheckoutResultDto['salons'] = [];
      for (const [i, group] of input.salons.entries()) {
        const r = await this.shopOrders.checkout(
          {
            items: group.items,
            contactName: input.contactName,
            contactPhone: input.contactPhone,
            contactEmail: input.contactEmail ?? null,
            note: group.note ?? null,
            fulfillment: 'PICKUP',
            paymentMethod: 'PAY_AT_SALON',
            expectedTotal: group.expectedTotal,
          },
          `dc-${checkoutId}-${i}`,
          customerUserId,
        );
        placed.push(() =>
          this.shopOrders.transition(
            r.order.id,
            { to: 'CANCELLED', note: 'Checkout could not be completed' },
            'CUSTOMER',
            customerUserId,
          ),
        );
        salons.push({
          orderNumber: r.order.orderNumber,
          accessToken: r.accessToken,
          salonName: r.order.salon.name,
          total: r.order.total,
        });
      }
      const checkout = await this.prisma.commerceCheckout.findUniqueOrThrow({
        where: { id: checkoutId },
      });
      const result: CommerceCheckoutResultDto = {
        checkoutNumber: checkout.number,
        created: true,
        fastque,
        salons,
      };
      // Order links are derived from ids, so no secret is stored with the replayable result.
      await this.prisma.commerceCheckout.update({
        where: { id: checkoutId },
        data: { result: this.stripTokens(result) },
      });
      return result;
    } catch (error) {
      // A duplicate request may have finished this same checkout: never cancel its orders.
      const finished = (
        await this.prisma.commerceCheckout.findUnique({
          where: { id: checkoutId },
        })
      )?.result as unknown as
        (CommerceCheckoutResultDto & { failed?: string }) | null;
      if (finished && !finished.failed) return this.replay(finished);
      const message =
        error instanceof Error ? error.message : 'The order was not placed.';
      let undone = true;
      for (const undo of placed.reverse())
        await undo().catch((e: unknown) => {
          undone = false;
          this.log.error(
            `Checkout ${checkoutId}: an order could not be cancelled: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      const text = undone
        ? `${message} Nothing was ordered.`
        : `${message} Part of your order may still be open; check My orders or contact support.`;
      await this.prisma.commerceCheckout
        .update({
          where: { id: checkoutId },
          data: { result: { failed: text.slice(0, 500) } },
        })
        .catch(() => undefined);
      throw conflict('COMMERCE_CHECKOUT_FAILED', text);
    }
  }

  private stripTokens(r: CommerceCheckoutResultDto): Prisma.InputJsonObject {
    return {
      checkoutNumber: r.checkoutNumber,
      fastque: r.fastque
        ? { orderNumber: r.fastque.orderNumber, total: r.fastque.total }
        : null,
      salons: r.salons.map((s) => ({
        orderNumber: s.orderNumber,
        salonName: s.salonName,
        total: s.total,
      })),
    };
  }

  private async replay(
    r: CommerceCheckoutResultDto,
  ): Promise<CommerceCheckoutResultDto> {
    const own = r.fastque
      ? await this.prisma.commerceOrder.findUnique({
          where: { orderNumber: r.fastque.orderNumber },
          select: { id: true },
        })
      : null;
    const shops = await this.prisma.shopOrder.findMany({
      where: { orderNumber: { in: r.salons.map((s) => s.orderNumber) } },
      select: { id: true, orderNumber: true },
    });
    const { orderAccessToken } = await import('../shop/shop-order.service');
    return {
      checkoutNumber: r.checkoutNumber,
      created: false,
      fastque:
        r.fastque && own
          ? { ...r.fastque, accessToken: orderToken(own.id) }
          : null,
      salons: r.salons.map((s) => ({
        ...s,
        accessToken: orderAccessToken(
          shops.find((x) => x.orderNumber === s.orderNumber)?.id ?? '',
        ),
      })),
    };
  }

  private async preflight(input: CommerceCheckoutInput): Promise<void> {
    if (input.fastque) {
      const q = await this.quote({
        items: input.fastque.items,
        pincode: input.fastque.address.pincode,
        couponCode: input.fastque.couponCode,
        phone: normalizePhone(input.contactPhone),
      });
      this.assertQuote(
        q,
        input.fastque.expectedTotal,
        input.fastque.couponCode,
      );
    }
    const salonIds = new Set<string>();
    for (const group of input.salons) {
      const q = await this.shopOrders.quote({ items: group.items });
      if (q.blocking.length || !q.salon)
        throw conflict(
          'COMMERCE_CART_INVALID',
          `${q.salon?.name ?? 'Salon'}: ${q.blocking.join(' ') || 'unavailable'}`,
        );
      if (salonIds.has(q.salon.id))
        throw conflict(
          'COMMERCE_CART_INVALID',
          `Put all products from ${q.salon.name} in one group.`,
        );
      salonIds.add(q.salon.id);
      if (paise(group.expectedTotal) !== paise(q.total))
        throw conflict(
          'COMMERCE_PRICE_CHANGED',
          `Prices at ${q.salon.name} changed. The total is now ₹${q.total}.`,
        );
    }
  }

  private assertQuote(
    q: CommerceQuoteDto,
    expectedTotal: string,
    couponCode?: string,
  ): void {
    if (q.blocking.length)
      throw conflict('COMMERCE_CART_INVALID', q.blocking.join(' '));
    if (couponCode && !q.couponCode)
      throw conflict(
        'COMMERCE_COUPON_INVALID',
        q.couponMessage ?? 'The coupon is not valid.',
      );
    if (!q.serviceability?.serviceable)
      throw conflict(
        'COMMERCE_NOT_SERVICEABLE',
        'FastQue does not deliver to this PIN code yet.',
      );
    if (paise(expectedTotal) !== paise(q.total))
      throw conflict(
        'COMMERCE_PRICE_CHANGED',
        `The total is now ₹${q.total}. Review it and place the order again.`,
      );
  }

  private async createCheckout(
    key: string,
    requestHash: string,
    customerUserId: string | null,
  ) {
    try {
      return await this.prisma.commerceCheckout.create({
        data: {
          number: number('FQC'),
          idempotencyKey: key,
          requestHash,
          customerUserId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.commerceCheckout.findUniqueOrThrow({
          where: { idempotencyKey: key },
        });
        if (raced.requestHash === requestHash) return raced;
        throw conflict(
          'COMMERCE_IDEMPOTENCY_CONFLICT',
          'This checkout key was already used.',
        );
      }
      throw error;
    }
  }

  private async placeFastque(
    checkoutId: string,
    input: CommerceCheckoutInput,
    customerUserId: string | null,
  ) {
    const f = input.fastque!;
    const phone = normalizePhone(input.contactPhone);
    return this.prisma.$transaction(async (tx) => {
      // Serialises retries of this checkout: the second one finds the first one's order.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "commerce_checkouts" WHERE "id" = ${checkoutId}::uuid FOR UPDATE`,
      );
      const already = await tx.commerceOrder.findFirst({
        where: { checkoutId },
      });
      if (already) {
        if (already.status === 'CANCELLED')
          throw conflict(
            'COMMERCE_CHECKOUT_FAILED',
            'This checkout was cancelled. Start again.',
          );
        return already;
      }
      // Same phone → one order at a time, so the open-order and coupon limits cannot be raced.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce:${phone}`}, 0))`,
      );
      if (f.couponCode)
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "commerce_coupons" WHERE "code" = ${f.couponCode.trim().toUpperCase()} FOR UPDATE`,
        );
      const open = await tx.commerceOrder.count({
        where: { contactPhone: phone, status: { in: OPEN } },
      });
      if (open >= MAX_OPEN_COD_ORDERS)
        throw conflict(
          'COMMERCE_COD_LIMIT',
          'This phone number already has several Cash on Delivery orders on the way. Please wait for one to arrive.',
        );
      const zone = await this.catalog.zoneFor(f.address.pincode, tx);
      if (!zone)
        throw conflict(
          'COMMERCE_NOT_SERVICEABLE',
          'FastQue does not deliver to this PIN code yet.',
        );
      const listingIds = [...new Set(f.items.map((i) => i.listingId))];
      await this.stock.lockListings(tx, listingIds, zone.warehouseId);
      const q = await this.quote(
        {
          items: f.items,
          pincode: f.address.pincode,
          couponCode: f.couponCode,
          phone,
        },
        tx,
      );
      this.assertQuote(q, f.expectedTotal, f.couponCode);
      const rows = new Map(
        (
          await tx.commerceListing.findMany({
            where: { id: { in: listingIds } },
            include: listingInclude,
          })
        ).map((l) => [l.id, l]),
      );
      const rules = await returnRules(tx);
      const seller = rows.get(q.lines[0].listingId)!.seller;
      const order = await tx.commerceOrder.create({
        data: {
          orderNumber: number('FQD'),
          checkoutId,
          sellerId: seller.id,
          sellerName: seller.displayName,
          warehouseId: zone.warehouseId,
          customerUserId,
          contactName: input.contactName,
          contactPhone: phone,
          contactEmail: input.contactEmail ?? null,
          shippingAddress: f.address,
          ...(f.billingAddress ? { billingAddress: f.billingAddress } : {}),
          instructions: f.instructions ?? null,
          accessTokenHash: 'pending',
          subtotal: q.subtotal,
          discountTotal: q.discountTotal,
          deliveryCharge: q.deliveryCharge ?? '0',
          taxIncluded: q.taxIncluded,
          total: q.total,
          couponCode: q.couponCode,
          ...(q.applied.length
            ? {
                promotions: q.applied as unknown as Prisma.InputJsonArray,
              }
            : {}),
          minDays: zone.minDays,
          maxDays: zone.maxDays,
          events: {
            create: {
              toStatus: 'PLACED',
              actorKind: customerUserId ? 'CUSTOMER' : 'GUEST',
              actorUserId: customerUserId,
            },
          },
        },
      });
      for (const l of q.lines) {
        const row = rows.get(l.listingId)!;
        const alloc = await this.stock.reserve(
          tx,
          l.listingId,
          zone.warehouseId,
          l.quantity,
          order.orderNumber,
          customerUserId,
        );
        await tx.commerceOrderItem.create({
          data: {
            orderId: order.id,
            listingId: l.listingId,
            globalProductId: l.productId,
            sku: row.sku,
            productName: l.name.slice(0, 160),
            brand: l.brand,
            category: row.globalProduct.category,
            variant: l.variant,
            barcode: row.globalProduct.barcodes[0]?.display ?? null,
            hsnCode: row.globalProduct.hsnCode,
            gstRatePercent: row.globalProduct.gstRatePercent,
            quantity: l.quantity,
            mrp: l.mrp,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            costTotal: alloc.reduce(
              (n, a) => n.add(a.unitCost.mul(a.quantity)),
              new Prisma.Decimal(0),
            ),
            ...returnRule(row, rules),
            allocations: {
              create: alloc.map((a) => ({
                batchId: a.batchId,
                quantity: a.quantity,
              })),
            },
          },
        });
      }
      if (q.couponId)
        await tx.commerceCouponUse.create({
          data: { couponId: q.couponId, orderId: order.id, phone },
        });
      await tx.auditLog.create({
        data: {
          actorUserId: customerUserId,
          action: 'COMMERCE_ORDER_PLACED',
          entityType: 'CommerceOrder',
          entityId: order.id,
          metadata: {
            total: q.total,
            lines: q.lines.length,
            guest: !customerUserId,
          },
        },
      });
      await this.notify(tx, order, 'PLACED', `${order.id}:PLACED`);
      return tx.commerceOrder.update({
        where: { id: order.id },
        data: { accessTokenHash: sha256(orderToken(order.id)) },
      });
    }, TX_OPTIONS);
  }

  private notify(
    tx: Tx,
    o: { id: string; orderNumber: string; customerUserId: string | null },
    to: CommerceOrderStatus,
    dedupe: string,
  ) {
    return this.outbox.add(tx, {
      dedupeKey: `commerce:${dedupe}`,
      userId: o.customerUserId,
      type: 'commerce.order.updated',
      payload: {
        orderNumber: o.orderNumber,
        status: COMMERCE_STATUS_LABEL[to],
      },
      deepLink: `shop/delivery/${o.orderNumber}`,
    });
  }

  // ---------- Reading ----------

  async forGuest(
    orderNumber: string,
    token: string,
  ): Promise<CommerceOrderRow> {
    const o = await this.prisma.commerceOrder.findUnique({
      where: { orderNumber },
      include: orderInclude,
    });
    const ok =
      !!o &&
      o.accessTokenHash.length === 64 &&
      timingSafeEqual(
        Buffer.from(o.accessTokenHash, 'hex'),
        Buffer.from(sha256(token), 'hex'),
      );
    if (!o || !ok)
      throw fail(
        'COMMERCE_ORDER_NOT_FOUND',
        'Order not found. Check the link from your order confirmation.',
        HttpStatus.NOT_FOUND,
      );
    return o;
  }

  async forCustomer(
    userId: string,
    orderNumber: string,
  ): Promise<CommerceOrderRow> {
    const o = await this.prisma.commerceOrder.findFirst({
      where: { orderNumber, customerUserId: userId },
      include: orderInclude,
    });
    if (!o) throw notFound('The order');
    return o;
  }

  async listForCustomer(userId: string): Promise<CommerceOrderDto[]> {
    const rows = await this.prisma.commerceOrder.findMany({
      where: { customerUserId: userId },
      include: orderInclude,
      orderBy: { placedAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => toCommerceOrderDto(r, 'CUSTOMER'));
  }

  async byId(id: string): Promise<CommerceOrderRow> {
    const o = await this.prisma.commerceOrder.findUnique({
      where: { id },
      include: orderInclude,
    });
    if (!o) throw notFound('The order');
    return o;
  }

  // ---------- Status changes ----------

  async transition(
    orderId: string,
    input: CommerceTransitionInput,
    actor: CommerceActor,
    actorUserId: string | null,
  ): Promise<CommerceOrderDto> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, orderId);
      if (o.status === input.to) return; // retry of the same step
      if (!canCommerceTransition(o.status, input.to, actor))
        throw conflict(
          'COMMERCE_TRANSITION',
          `An order that is "${COMMERCE_STATUS_LABEL[o.status]}" cannot be moved to "${COMMERCE_STATUS_LABEL[input.to]}".`,
        );
      const now = new Date();
      const ref = o.orderNumber;
      let data: Prisma.CommerceOrderUpdateInput = { status: input.to };
      if (input.packagingCost) data.packagingCost = input.packagingCost;
      if (input.to === 'CANCELLED') {
        await this.stock.releaseOrder(tx, o.id, ref, actorUserId);
        await tx.commerceCouponUse.updateMany({
          where: { orderId: o.id },
          data: { released: true },
        });
        data = {
          ...data,
          cancelledAt: now,
          cancelReason: input.note ?? null,
          paymentStatus: 'VOID',
        };
      }
      if (input.to === 'SHIPPED') {
        if (!input.shipment)
          throw fail(
            'COMMERCE_SHIPMENT_REQUIRED',
            'Enter the courier (or "FastQue delivery") to ship this order.',
          );
        await this.stock.dispatchOrder(tx, o.id, ref, actorUserId);
        await tx.commerceShipment.create({
          data: {
            orderId: o.id,
            ...input.shipment,
            expectedOn: input.shipment.expectedOn
              ? dateOnly(input.shipment.expectedOn)
              : null,
          },
        });
        data.shippedAt = now;
      }
      if (input.to === 'OUT_FOR_DELIVERY')
        await tx.commerceShipment.updateMany({
          where: { orderId: o.id },
          data: { attempts: { increment: 1 } },
        });
      if (input.to === 'DELIVERED') {
        // Delivery never marks the cash as collected; finance records that separately.
        data.deliveredAt = now;
        if (input.proofNote)
          await tx.commerceShipment.updateMany({
            where: { orderId: o.id },
            data: { proofNote: input.proofNote },
          });
      }
      if (input.to === 'RETURNED') {
        const items = await tx.commerceOrderItem.findMany({
          where: { orderId: o.id },
        });
        for (const i of items)
          await this.stock.quarantineReturned(
            tx,
            i.id,
            i.quantity,
            `${ref}:RTO`,
            actorUserId,
          );
        data.paymentStatus = 'VOID';
      }
      await tx.commerceOrder.update({ where: { id: o.id }, data });
      const event = await tx.commerceOrderEvent.create({
        data: {
          orderId: o.id,
          fromStatus: o.status,
          toStatus: input.to,
          actorKind:
            actor === 'STAFF' ? 'STAFF' : actorUserId ? 'CUSTOMER' : 'GUEST',
          actorUserId,
          note: input.note ?? null,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: `COMMERCE_ORDER_${input.to}`,
          entityType: 'CommerceOrder',
          entityId: o.id,
          metadata: { from: o.status, actor },
        },
      });
      await this.notify(tx, o, input.to, event.id);
    }, TX_OPTIONS);
    return toCommerceOrderDto(await this.byId(orderId), actor);
  }

  private async lockOrder(tx: Tx, id: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "commerce_orders" WHERE "id" = ${id}::uuid FOR UPDATE`,
    );
    if (!locked.length) throw notFound('The order');
    return tx.commerceOrder.findUniqueOrThrow({ where: { id } });
  }

  // ---------- Cash on Delivery ----------

  private async codTotals(tx: Db, orderId: string) {
    const rows = await tx.commerceCodEntry.findMany({ where: { orderId } });
    const sum = (kind: string) =>
      rows
        .filter((r) => r.kind === kind)
        .reduce((n, r) => n + paise(r.amount.toFixed(2)), 0);
    return {
      collected: sum('COLLECTED'),
      settled: sum('SETTLED'),
      adjusted: sum('ADJUSTMENT'),
      refunded: sum('REFUND'),
      rows,
    };
  }

  async recordCod(
    orderId: string,
    input: CommerceCodEntryInput,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, orderId);
      const done = await tx.commerceCodEntry.findUnique({
        where: { idempotencyKey },
      });
      if (done) {
        if (done.orderId !== orderId || done.kind !== input.kind)
          throw conflict(
            'COMMERCE_IDEMPOTENCY_CONFLICT',
            'This request key was already used.',
          );
        return;
      }
      if (o.paymentStatus === 'RECONCILED' && input.kind !== 'REFUND')
        throw conflict('COMMERCE_COD', 'This order is already reconciled.');
      if (o.status !== 'DELIVERED')
        throw conflict(
          'COMMERCE_COD',
          'Cash can only be recorded for a delivered order.',
        );
      if (input.kind === 'REFUND')
        throw conflict(
          'COMMERCE_COD',
          'Refunds are recorded from the return request.',
        );
      const t = await this.codTotals(tx, orderId);
      const amount = paise(input.amount);
      const due = paise(o.total.toFixed(2));
      if (input.kind === 'COLLECTED' && t.collected + amount > due)
        throw conflict(
          'COMMERCE_COD',
          `Only ₹${rupeesOf(due - t.collected)} is still to be collected.`,
        );
      if (input.kind === 'SETTLED') {
        if (t.settled + amount > t.collected)
          throw conflict(
            'COMMERCE_COD',
            'A settlement cannot be more than the cash collected.',
          );
        if (paise(input.deductions) > amount)
          throw conflict(
            'COMMERCE_COD',
            'Deductions cannot be more than the settlement.',
          );
      }
      await tx.commerceCodEntry.create({
        data: {
          orderId,
          kind: input.kind,
          amount: input.amount,
          deductions: input.kind === 'SETTLED' ? input.deductions : '0',
          reference: input.reference ?? null,
          occurredOn: dateOnly(input.occurredOn),
          note: input.note ?? null,
          actorUserId,
          idempotencyKey,
        },
      });
      await this.refreshPayment(tx, orderId, o.paymentStatus, due);
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: `COMMERCE_COD_${input.kind}`,
          entityType: 'CommerceOrder',
          entityId: orderId,
          metadata: {
            amount: input.amount,
            reference: input.reference ?? null,
          },
        },
      });
    }, TX_OPTIONS);
  }

  private async refreshPayment(
    tx: Tx,
    orderId: string,
    current: CommercePaymentStatus,
    due: number,
  ): Promise<void> {
    if (['REFUND_PENDING', 'REFUNDED_OFFLINE'].includes(current)) return;
    const t = await this.codTotals(tx, orderId);
    const status: CommercePaymentStatus =
      t.settled + t.adjusted >= due
        ? 'SETTLEMENT_PENDING'
        : t.settled > 0
          ? 'PARTIALLY_SETTLED'
          : t.collected >= due
            ? 'COD_COLLECTED'
            : 'COD_PENDING';
    await tx.commerceOrder.update({
      where: { id: orderId },
      data: { paymentStatus: status },
    });
  }

  /** Finance sign-off. Never automatic; an adjustment must be signed off by someone else. */
  async reconcile(orderId: string, actorUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, orderId);
      if (o.paymentStatus === 'RECONCILED') return;
      const t = await this.codTotals(tx, orderId);
      const due = paise(o.total.toFixed(2));
      if (
        o.paymentStatus !== 'SETTLEMENT_PENDING' ||
        t.settled + t.adjusted !== due
      )
        throw conflict(
          'COMMERCE_COD',
          `Settled plus adjustments is ₹${rupeesOf(t.settled + t.adjusted)}; the order is ₹${rupeesOf(due)}.`,
        );
      if (
        t.rows.some(
          (r) => r.kind === 'ADJUSTMENT' && r.actorUserId === actorUserId,
        )
      )
        throw fail(
          'COMMERCE_COD_SECOND_PERSON',
          'An adjustment you recorded must be signed off by someone else.',
          HttpStatus.FORBIDDEN,
        );
      await tx.commerceOrder.update({
        where: { id: orderId },
        data: { paymentStatus: 'RECONCILED' },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'COMMERCE_COD_RECONCILED',
          entityType: 'CommerceOrder',
          entityId: orderId,
          metadata: {},
        },
      });
    }, TX_OPTIONS);
  }

  // ---------- Returns ----------

  async requestReturn(
    o: CommerceOrderRow,
    input: CommerceReturnRequestInput,
    actorUserId: string | null,
  ): Promise<CommerceOrderDto> {
    if (!flag('FASTQUE_RETURNS_ENABLED'))
      throw conflict('COMMERCE_RETURNS_DISABLED', 'Returns are not open yet.');
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrder(tx, o.id);
      const fresh = await tx.commerceOrder.findUniqueOrThrow({
        where: { id: o.id },
        include: orderInclude,
      });
      if (fresh.status !== 'DELIVERED' || !fresh.deliveredAt)
        throw conflict(
          'COMMERCE_RETURN',
          'Only delivered products can be returned.',
        );
      const dto = toCommerceOrderDto(fresh, 'CUSTOMER');
      const ids = input.items.map((i) => i.orderItemId);
      if (new Set(ids).size !== ids.length)
        throw fail('COMMERCE_RETURN', 'Choose each product once.');
      for (const line of input.items) {
        const item = dto.items.find((i) => i.id === line.orderItemId);
        if (!item?.returnableUntil)
          throw conflict('COMMERCE_RETURN', 'This product cannot be returned.');
        if (new Date(item.returnableUntil) < new Date())
          throw conflict(
            'COMMERCE_RETURN',
            `The return window for ${item.name} has closed.`,
          );
        if (line.quantity > item.returnableQuantity)
          throw conflict(
            'COMMERCE_RETURN',
            `At most ${item.returnableQuantity} of ${item.name} can be returned.`,
          );
      }
      const created = await tx.commerceReturn.create({
        data: {
          number: number('FQR'),
          orderId: o.id,
          reason: input.reason,
          resolution: input.resolution,
          details: input.details ?? null,
          items: { create: input.items },
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: 'COMMERCE_RETURN_REQUESTED',
          entityType: 'CommerceReturn',
          entityId: created.id,
          metadata: { orderId: o.id, reason: input.reason },
        },
      });
    }, TX_OPTIONS);
    return toCommerceOrderDto(await this.byId(o.id), 'CUSTOMER');
  }

  async actOnReturn(
    returnId: string,
    input: CommerceReturnActionInput,
    actorUserId: string,
  ): Promise<CommerceOrderDto> {
    const head = await this.prisma.commerceReturn.findUnique({
      where: { id: returnId },
      select: { orderId: true },
    });
    if (!head) throw notFound('The return');
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lockOrder(tx, head.orderId);
      const r = await tx.commerceReturn.findUniqueOrThrow({
        where: { id: returnId },
        include: { items: { include: { orderItem: true } } },
      });
      if (r.status === input.to) return;
      if (!COMMERCE_RETURN_TRANSITIONS[r.status].includes(input.to))
        throw conflict(
          'COMMERCE_RETURN',
          `A return that is ${r.status} cannot become ${input.to}.`,
        );
      if (
        (input.to === 'REFUNDED' && r.resolution !== 'REFUND') ||
        (input.to === 'REPLACED' && r.resolution !== 'REPLACEMENT')
      )
        throw conflict(
          'COMMERCE_RETURN',
          `The customer asked for a ${r.resolution.toLowerCase()}.`,
        );
      // Missing products never arrived, so nothing physically comes back.
      const physical = r.reason !== 'MISSING';
      if (input.to === 'RECEIVED' && physical)
        for (const i of r.items)
          await this.stock.quarantineReturned(
            tx,
            i.orderItemId,
            i.quantity,
            `${r.number}:${i.id}`,
            actorUserId,
          );
      if (input.to === 'INSPECTED' && physical)
        for (const i of r.items) {
          const d = input.dispositions?.find(
            (x) => x.returnItemId === i.id,
          )?.disposition;
          if (!d)
            throw fail(
              'COMMERCE_RETURN',
              'Record the inspection result for every product.',
            );
          // Opened, damaged, expired or defective beauty products never go back on sale.
          if (
            d === 'RESTOCK' &&
            ['DAMAGED', 'EXPIRED', 'DEFECTIVE'].includes(r.reason)
          )
            throw conflict(
              'COMMERCE_RETURN',
              'Products returned as damaged, expired or defective cannot be restocked.',
            );
          await this.stock.inspectReturned(
            tx,
            `${r.number}:${i.id}`,
            d,
            actorUserId,
          );
          await tx.commerceReturnItem.update({
            where: { id: i.id },
            data: { disposition: d },
          });
        }
      if (input.to === 'INSPECTED' && r.resolution === 'REFUND')
        await tx.commerceOrder.update({
          where: { id: o.id },
          data: { paymentStatus: 'REFUND_PENDING' },
        });
      if (input.to === 'REFUNDED') {
        const goods = paise(o.subtotal.toFixed(2));
        const asked = r.items.reduce(
          (n, i) => n + paise(i.orderItem.unitPrice.toFixed(2)) * i.quantity,
          0,
        );
        // Each product carries its own offers and its share of any coupon.
        const offers = promotionsOf(o.promotions);
        const offTotal = offers.reduce((n, p) => n + p.amountPaise, 0);
        const offAsked = Math.round(
          r.items.reduce(
            (n, i) =>
              n +
              (offers.reduce(
                (x, p) => x + (p.perListing[i.orderItem.listingId] ?? 0),
                0,
              ) *
                i.quantity) /
                i.orderItem.quantity,
            0,
          ),
        );
        const couponPart = paise(o.discountTotal.toFixed(2)) - offTotal;
        const net = asked - offAsked;
        const value = Math.max(
          0,
          net -
            (goods > offTotal
              ? Math.round((couponPart * net) / (goods - offTotal))
              : 0),
        );
        const t = await this.codTotals(tx, o.id);
        const amount = input.refundAmount ? paise(input.refundAmount) : value;
        if (t.collected < paise(o.total.toFixed(2)))
          throw conflict(
            'COMMERCE_RETURN',
            'Record the cash collected for this order before refunding it.',
          );
        if (amount > asked || t.refunded + amount > t.collected)
          throw conflict(
            'COMMERCE_RETURN',
            'The refund is more than was paid for these products.',
          );
        await tx.commerceCodEntry.create({
          data: {
            orderId: o.id,
            kind: 'REFUND',
            amount: rupeesOf(amount),
            reference: input.refundReference ?? null,
            occurredOn: dateOnly(
              new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10),
            ),
            note: `Return ${r.number}`,
            actorUserId,
            idempotencyKey: `refund:${r.id}`,
          },
        });
        await tx.commerceOrder.update({
          where: { id: o.id },
          data: { paymentStatus: 'REFUNDED_OFFLINE' },
        });
      }
      if (input.to === 'REPLACED')
        for (const i of r.items) {
          const alloc = await this.stock.reserve(
            tx,
            i.orderItem.listingId,
            o.warehouseId,
            i.quantity,
            `${r.number}:REPL`,
            actorUserId,
          );
          await tx.commerceAllocation.createMany({
            data: alloc.map((a) => ({
              orderItemId: i.orderItemId,
              batchId: a.batchId,
              quantity: a.quantity,
            })),
          });
          await this.stock.dispatchOrder(
            tx,
            o.id,
            `${r.number}:REPL`,
            actorUserId,
          );
        }
      await tx.commerceReturn.update({
        where: { id: r.id },
        data: {
          status: input.to,
          ...(input.note ? { adminNote: input.note } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: `COMMERCE_RETURN_${input.to}`,
          entityType: 'CommerceReturn',
          entityId: r.id,
          metadata: { orderId: o.id },
        },
      });
      await this.outbox.add(tx, {
        dedupeKey: `commerce-return:${r.id}:${input.to}`,
        userId: o.customerUserId,
        type: 'commerce.return.updated',
        payload: { orderNumber: o.orderNumber, status: input.to },
        deepLink: `shop/delivery/${o.orderNumber}`,
      });
    }, TX_OPTIONS);
    return toCommerceOrderDto(await this.byId(head.orderId), 'STAFF');
  }
}
