import { z } from "zod";
import { shopCheckoutSchema } from "./shop";

// FastQue Direct Commerce: products FastQue itself sells and delivers (Cash on Delivery). The salon
// marketplace keeps its own contract in shop.ts; this file never changes it. Every price, stock and
// permission decision is made by the server; these are the shared rules and request shapes.

export const COMMERCE_PATHS = {
  root: "commerce",
  customer: "customer/commerce",
  admin: "commerce",
} as const;

export const COMMERCE_FLAGS = [
  "FASTQUE_DIRECT_COMMERCE_ENABLED",
  "MULTI_SELLER_CART_ENABLED",
  "FASTQUE_COD_ENABLED",
  "FASTQUE_DELIVERY_ENABLED",
  "FASTQUE_RETURNS_ENABLED",
  "FASTQUE_COMMERCE_AI_ENABLED",
] as const;
export type CommerceFlag = (typeof COMMERCE_FLAGS)[number];

export interface CommerceConfigDto {
  enabled: boolean;
  multiSellerCart: boolean;
  cod: boolean;
  delivery: boolean;
  returns: boolean;
  insights: boolean;
  seller: { name: string; supportEmail: string | null; supportPhone: string | null; legalName: string | null; gstin: string | null; address: string | null; grievance: string | null; returnPolicy: string | null } | null;
}

// ---------- Order state machine ----------

export const CommerceOrderStatus = {
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  PROCESSING: "PROCESSING",
  PACKED: "PACKED",
  SHIPPED: "SHIPPED",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  DELIVERY_FAILED: "DELIVERY_FAILED",
  RETURN_TO_ORIGIN: "RETURN_TO_ORIGIN",
  RETURNED: "RETURNED",
} as const;
export type CommerceOrderStatus = (typeof CommerceOrderStatus)[keyof typeof CommerceOrderStatus];
export type CommerceActor = "CUSTOMER" | "STAFF";

const S: readonly CommerceActor[] = ["STAFF"];
const SC: readonly CommerceActor[] = ["STAFF", "CUSTOMER"];

/**
 * The only allowed changes. Customers can cancel until the parcel is packed; after dispatch the only
 * ways back are a failed delivery and return to origin. DELIVERY_FAILED -> OUT_FOR_DELIVERY is a
 * rescheduled attempt. RETURNED here means the undelivered parcel is back in the warehouse.
 */
export const COMMERCE_TRANSITIONS: Record<CommerceOrderStatus, Partial<Record<CommerceOrderStatus, readonly CommerceActor[]>>> = {
  PLACED: { CONFIRMED: S, CANCELLED: SC },
  CONFIRMED: { PROCESSING: S, PACKED: S, CANCELLED: SC },
  PROCESSING: { PACKED: S, CANCELLED: SC },
  PACKED: { SHIPPED: S, CANCELLED: S },
  SHIPPED: { OUT_FOR_DELIVERY: S, DELIVERY_FAILED: S, RETURN_TO_ORIGIN: S },
  OUT_FOR_DELIVERY: { DELIVERED: S, DELIVERY_FAILED: S },
  DELIVERY_FAILED: { OUT_FOR_DELIVERY: S, RETURN_TO_ORIGIN: S },
  RETURN_TO_ORIGIN: { RETURNED: S },
  DELIVERED: {},
  CANCELLED: {},
  RETURNED: {},
};
export const canCommerceTransition = (from: CommerceOrderStatus, to: CommerceOrderStatus, actor: CommerceActor): boolean =>
  !!COMMERCE_TRANSITIONS[from]?.[to]?.includes(actor);
export const allowedCommerceTransitions = (from: CommerceOrderStatus, actor: CommerceActor): CommerceOrderStatus[] =>
  (Object.keys(COMMERCE_TRANSITIONS[from]) as CommerceOrderStatus[]).filter((to) => canCommerceTransition(from, to, actor));

export const COMMERCE_STATUS_LABEL: Record<CommerceOrderStatus, string> = {
  PLACED: "Placed",
  CONFIRMED: "Confirmed",
  PROCESSING: "Being prepared",
  PACKED: "Packed",
  SHIPPED: "Shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  DELIVERY_FAILED: "Delivery attempt failed",
  RETURN_TO_ORIGIN: "Returning to FastQue",
  RETURNED: "Returned to FastQue",
};
export const COMMERCE_TIMELINE: readonly CommerceOrderStatus[] = ["PLACED", "CONFIRMED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

export const CommercePaymentStatus = {
  COD_PENDING: "COD_PENDING",
  COD_COLLECTED: "COD_COLLECTED",
  SETTLEMENT_PENDING: "SETTLEMENT_PENDING",
  PARTIALLY_SETTLED: "PARTIALLY_SETTLED",
  RECONCILED: "RECONCILED",
  REFUND_PENDING: "REFUND_PENDING",
  REFUNDED_OFFLINE: "REFUNDED_OFFLINE",
  VOID: "VOID",
} as const;
export type CommercePaymentStatus = (typeof CommercePaymentStatus)[keyof typeof CommercePaymentStatus];
export const COMMERCE_PAYMENT_LABEL: Record<CommercePaymentStatus, string> = {
  COD_PENDING: "Cash on Delivery — not collected yet",
  COD_COLLECTED: "Cash collected",
  SETTLEMENT_PENDING: "Collected, settlement pending",
  PARTIALLY_SETTLED: "Partly settled",
  RECONCILED: "Reconciled",
  REFUND_PENDING: "Refund pending",
  REFUNDED_OFFLINE: "Refunded",
  VOID: "Nothing to pay",
};

export const COMMERCE_RETURN_REASONS = ["WRONG_PRODUCT", "DAMAGED", "MISSING", "EXPIRED", "DEFECTIVE", "OTHER"] as const;
export type CommerceReturnReason = (typeof COMMERCE_RETURN_REASONS)[number];
export const CommerceReturnStatus = {
  REQUESTED: "REQUESTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  RECEIVED: "RECEIVED",
  INSPECTED: "INSPECTED",
  REFUNDED: "REFUNDED",
  REPLACED: "REPLACED",
  CLOSED: "CLOSED",
} as const;
export type CommerceReturnStatus = (typeof CommerceReturnStatus)[keyof typeof CommerceReturnStatus];
export const COMMERCE_RETURN_TRANSITIONS: Record<CommerceReturnStatus, readonly CommerceReturnStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["RECEIVED", "REJECTED"],
  RECEIVED: ["INSPECTED"],
  INSPECTED: ["REFUNDED", "REPLACED"],
  REFUNDED: ["CLOSED"],
  REPLACED: ["CLOSED"],
  REJECTED: [],
  CLOSED: [],
};

// ---------- Money (integer paise; inputs are 2-decimal strings) ----------

export const paise = (rupees: string | number): number => Math.round(Number(rupees) * 100);
export const rupeesOf = (p: number): string => (p / 100).toFixed(2);
/** Tax contained in a tax-inclusive amount. */
export const taxInside = (inclusivePaise: number, ratePercent: number): number =>
  ratePercent > 0 ? Math.round((inclusivePaise * ratePercent) / (100 + ratePercent)) : 0;

/** The price in force now: the promotional price only inside its window. */
export function effectivePrice(l: { price: string; promoPrice: string | null; promoStartsAt: Date | null; promoEndsAt: Date | null }, now: Date): string {
  if (l.promoPrice == null) return l.price;
  if (l.promoStartsAt && now < l.promoStartsAt) return l.price;
  if (l.promoEndsAt && now >= l.promoEndsAt) return l.price;
  return Number(l.promoPrice) < Number(l.price) ? l.promoPrice : l.price;
}

// ---------- Delivery serviceability ----------

export interface ZoneRule {
  id: string;
  priority: number;
  isActive: boolean;
  pinRules: string[];
  blockedPins: string[];
}
/** Best zone for a PIN: lowest priority number first, then the most specific matching rule. */
export function matchZone<T extends ZoneRule>(pin: string, zones: readonly T[]): T | null {
  if (!/^[1-9]\d{5}$/.test(pin)) return null;
  let best: { zone: T; length: number } | null = null;
  for (const zone of zones) {
    if (!zone.isActive || zone.blockedPins.includes(pin)) continue;
    const length = Math.max(0, ...zone.pinRules.filter((r) => /^\d{1,6}$/.test(r) && pin.startsWith(r)).map((r) => r.length));
    if (!length) continue;
    if (!best || zone.priority < best.zone.priority || (zone.priority === best.zone.priority && length > best.length)) best = { zone, length };
  }
  return best?.zone ?? null;
}

// ---------- Coupons ----------

export interface CouponRule {
  kind: string;
  value: string;
  maxDiscount: string | null;
  minOrder: string;
}
/** Discount in paise on the eligible goods. FREE_DELIVERY discounts the delivery charge instead. */
export function couponDiscount(c: CouponRule, eligiblePaise: number, deliveryPaise: number): number {
  if (c.kind === "FREE_DELIVERY") return deliveryPaise;
  const raw = c.kind === "PERCENT" ? Math.floor((eligiblePaise * Number(c.value)) / 100) : paise(c.value);
  const capped = c.maxDiscount ? Math.min(raw, paise(c.maxDiscount)) : raw;
  return Math.max(0, Math.min(capped, eligiblePaise));
}

// ---------- Staff permissions ----------

export const COMMERCE_PERMISSIONS = ["view", "catalog", "warehouse", "procurement", "orders", "delivery", "finance", "support", "settings"] as const;
export type CommercePermission = (typeof COMMERCE_PERMISSIONS)[number];

// ---------- Schemas ----------

const uuid = z.string().uuid();
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount like 499 or 499.50");
const positiveMoney = money.refine((v) => Number(v) > 0, "Must be more than 0");
const phone = z.string().trim().regex(/^\+?[0-9][0-9\s-]{7,17}$/, "Enter a valid phone number");
const pin = z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit PIN code");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => z.string().trim().max(max).nullish();

export const commerceProductsQuerySchema = z
  .object({
    q: text(120).optional(),
    category: text(80).optional(),
    brand: text(120).optional(),
    minPrice: z.coerce.number().min(0).max(1_000_000).optional(),
    maxPrice: z.coerce.number().min(0).max(1_000_000).optional(),
    availableOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
    onSale: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
    sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "popular"]).default("relevance"),
    page: z.coerce.number().int().min(1).max(500).default(1),
    limit: z.coerce.number().int().min(1).max(48).default(24),
  })
  .strict();
export type CommerceProductsQuery = z.infer<typeof commerceProductsQuerySchema>;

export const commercePinQuerySchema = z.object({ pin }).strict();
const line = z.object({ listingId: uuid, quantity: z.number().int().min(1).max(50) }).strict();
export const commerceQuoteSchema = z
  .object({ items: z.array(line).min(1).max(20), pincode: pin.optional(), couponCode: text(30).optional() })
  .strict();
export type CommerceQuoteInput = z.infer<typeof commerceQuoteSchema>;

export const commerceAddressSchema = z
  .object({
    label: optText(40),
    name: text(120).min(2),
    phone,
    line1: text(160).min(3),
    line2: optText(160),
    landmark: optText(120),
    city: text(80).min(2),
    state: text(80).min(2),
    pincode: pin,
    isDefault: z.boolean().optional(),
  })
  .strict();
export type CommerceAddressInput = z.infer<typeof commerceAddressSchema>;

const expected = z.string().regex(/^\d+(\.\d{1,2})?$/);
export const commerceCheckoutSchema = z
  .object({
    contactName: text(120).min(2),
    contactPhone: phone,
    contactEmail: z.string().trim().email().max(254).nullish(),
    fastque: z
      .object({
        items: z.array(line).min(1).max(20),
        address: commerceAddressSchema,
        billingAddress: commerceAddressSchema.nullish(),
        instructions: optText(300),
        couponCode: text(30).optional(),
        expectedTotal: expected,
      })
      .strict()
      .optional(),
    salons: z
      .array(z.object({ items: shopCheckoutSchema.shape.items, note: optText(300), expectedTotal: expected }).strict())
      .max(10)
      .default([]),
  })
  .strict()
  .refine((v) => v.fastque || v.salons.length, { message: "The bag is empty." });
export type CommerceCheckoutInput = z.infer<typeof commerceCheckoutSchema>;

export const commerceReturnRequestSchema = z
  .object({
    items: z.array(z.object({ orderItemId: uuid, quantity: z.number().int().min(1).max(50) }).strict()).min(1).max(20),
    reason: z.enum(COMMERCE_RETURN_REASONS),
    resolution: z.enum(["REFUND", "REPLACEMENT"]),
    details: optText(1000),
  })
  .strict();
export type CommerceReturnRequestInput = z.infer<typeof commerceReturnRequestSchema>;

// Admin
export const commerceSellerSettingsSchema = z
  .object({
    displayName: text(120).min(2),
    legalName: optText(160),
    gstin: z.string().trim().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid GSTIN").nullish(),
    address: optText(400),
    supportEmail: z.string().trim().email().max(254).nullish(),
    supportPhone: phone.nullish(),
    grievance: optText(400),
    returnPolicy: optText(2000),
  })
  .strict();
export const commerceGrantSchema = z.object({ userId: z.string().min(1).max(60), permission: z.enum(COMMERCE_PERMISSIONS), granted: z.boolean() }).strict();
export const commerceWarehouseSchema = z
  .object({ code: text(20).min(2), name: text(120).min(2), address: optText(400), city: optText(80), state: optText(80), pincode: pin.nullish(), isActive: z.boolean().default(true) })
  .strict();
export const commerceListingSchema = z
  .object({
    globalProductId: z.string().min(1).max(60),
    sku: text(60).min(2),
    mrp: positiveMoney,
    price: positiveMoney,
    promoPrice: positiveMoney.nullish(),
    promoStartsAt: z.string().datetime().nullish(),
    promoEndsAt: z.string().datetime().nullish(),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]).default("DRAFT"),
    maxPerOrder: z.number().int().min(1).max(50).default(5),
    weightGrams: z.number().int().min(1).max(50_000).default(500),
    codEligible: z.boolean().default(true),
    returnable: z.boolean().default(true),
    returnWindowDays: z.number().int().min(0).max(60).default(7),
    reorderLevel: z.number().int().min(0).max(1_000_000).default(0),
    safetyStock: z.number().int().min(0).max(1_000_000).default(0),
    expiryTracked: z.boolean().default(true),
    featured: z.boolean().default(false),
    /** Needed when a price is below the highest batch cost, so a loss is never accidental. */
    confirmBelowCost: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Number(v.price) <= Number(v.mrp), { message: "The selling price cannot be above the MRP.", path: ["price"] })
  .refine((v) => v.promoPrice == null || Number(v.promoPrice) <= Number(v.price), { message: "The promotional price cannot be above the selling price.", path: ["promoPrice"] });
export type CommerceListingInput = z.infer<typeof commerceListingSchema>;

export const commerceStockInSchema = z
  .object({
    listingId: uuid,
    warehouseId: uuid,
    batchNumber: text(60).min(1),
    manufacturedOn: day.nullish(),
    expiresOn: day.nullish(),
    unitCost: money,
    quantity: z.number().int().min(1).max(1_000_000),
    storageLocation: optText(60),
    note: optText(300),
  })
  .strict();
export type CommerceStockInInput = z.infer<typeof commerceStockInSchema>;
export const commerceStockAdjustSchema = z
  .object({
    kind: z.enum(["ADJUSTMENT", "DAMAGE", "EXPIRE", "QUARANTINE_IN", "QUARANTINE_OUT"]),
    /** ADJUSTMENT may be negative; the others move that many units between conditions. */
    quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0),
    note: text(300).min(3),
  })
  .strict();
export type CommerceStockAdjustInput = z.infer<typeof commerceStockAdjustSchema>;
export const commerceTransferSchema = z.object({ toWarehouseId: uuid, quantity: z.number().int().min(1).max(1_000_000), note: optText(300) }).strict();

export const commerceZoneSchema = z
  .object({
    name: text(80).min(2),
    warehouseId: uuid,
    isActive: z.boolean().default(true),
    priority: z.number().int().min(1).max(1000).default(100),
    deliveryCharge: money,
    freeAbove: money.nullish(),
    minDays: z.number().int().min(0).max(60),
    maxDays: z.number().int().min(0).max(90),
    codEligible: z.boolean().default(true),
    maxCodAmount: money.nullish(),
    minOrderAmount: money.nullish(),
    maxWeightGrams: z.number().int().min(1).max(1_000_000).nullish(),
    pinRules: z.array(z.string().regex(/^\d{1,6}$/)).min(1).max(2000),
    blockedPins: z.array(z.string().regex(/^\d{6}$/)).max(2000).default([]),
  })
  .strict()
  .refine((v) => v.maxDays >= v.minDays, { message: "Maximum days must be at least the minimum.", path: ["maxDays"] });

export const commerceTransitionSchema = z
  .object({
    to: z.nativeEnum(CommerceOrderStatus),
    note: text(300).optional(),
    shipment: z
      .object({
        courier: text(80).min(2),
        trackingNumber: optText(80),
        trackingUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Use an https link").nullish(),
        weightGrams: z.number().int().min(1).max(1_000_000).nullish(),
        courierCost: money.default("0"),
        codFee: money.default("0"),
        expectedOn: day.nullish(),
      })
      .strict()
      .optional(),
    proofNote: text(300).optional(),
    packagingCost: money.optional(),
  })
  .strict();
export type CommerceTransitionInput = z.infer<typeof commerceTransitionSchema>;

export const commerceCodEntrySchema = z
  .object({
    kind: z.enum(["COLLECTED", "SETTLED", "ADJUSTMENT", "REFUND"]),
    /** ADJUSTMENT may be negative (a written-off shortfall is a positive adjustment toward the due amount). */
    amount: z.string().regex(/^-?\d{1,9}(\.\d{1,2})?$/),
    deductions: money.default("0"),
    reference: optText(80),
    occurredOn: day,
    note: optText(300),
  })
  .strict()
  .refine((v) => v.kind === "ADJUSTMENT" || Number(v.amount) > 0, { message: "Enter an amount above 0.", path: ["amount"] })
  .refine((v) => v.kind !== "ADJUSTMENT" || !!v.note, { message: "Explain the adjustment.", path: ["note"] });
export type CommerceCodEntryInput = z.infer<typeof commerceCodEntrySchema>;

export const commerceReturnActionSchema = z
  .object({
    to: z.nativeEnum(CommerceReturnStatus),
    note: text(500).optional(),
    dispositions: z.array(z.object({ returnItemId: uuid, disposition: z.enum(["RESTOCK", "DAMAGED"]) }).strict()).optional(),
    refundAmount: positiveMoney.optional(),
    refundReference: text(80).optional(),
  })
  .strict()
  .refine((v) => v.to !== "REJECTED" || !!v.note, { message: "Give the customer a reason.", path: ["note"] });
export type CommerceReturnActionInput = z.infer<typeof commerceReturnActionSchema>;

export const commerceCouponSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,30}$/),
    description: optText(200),
    kind: z.enum(["PERCENT", "FIXED", "FREE_DELIVERY"]),
    value: money.default("0"),
    maxDiscount: money.nullish(),
    minOrder: money.default("0"),
    brand: optText(120),
    category: optText(80),
    firstOrderOnly: z.boolean().default(false),
    usageLimit: z.number().int().min(1).nullish(),
    perCustomer: z.number().int().min(1).max(100).default(1),
    startsAt: z.string().datetime().nullish(),
    endsAt: z.string().datetime().nullish(),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.kind === "FREE_DELIVERY" || Number(v.value) > 0, { message: "Enter the discount.", path: ["value"] })
  .refine((v) => v.kind !== "PERCENT" || Number(v.value) <= 90, { message: "At most 90%.", path: ["value"] });

export const commerceSupplierSchema = z
  .object({
    name: text(160).min(2),
    contactName: optText(120),
    phone: phone.nullish(),
    email: z.string().trim().email().max(254).nullish(),
    gstin: optText(15),
    address: optText(400),
    brands: z.array(text(120)).max(100).default([]),
    creditDays: z.number().int().min(0).max(365).default(0),
    leadTimeDays: z.number().int().min(0).max(365).nullish(),
    isActive: z.boolean().default(true),
    notes: optText(1000),
  })
  .strict();
export const commerceSupplierProductSchema = z.object({ listingId: uuid, unitCost: positiveMoney, minQty: z.number().int().min(1).default(1) }).strict();
export const commercePoSchema = z
  .object({
    supplierId: uuid,
    warehouseId: uuid,
    expectedOn: day.nullish(),
    note: optText(500),
    items: z.array(z.object({ listingId: uuid, quantity: z.number().int().min(1).max(1_000_000), unitCost: positiveMoney }).strict()).min(1).max(200),
  })
  .strict();
export const commercePoActionSchema = z.object({ action: z.enum(["APPROVE", "ORDER", "CANCEL"]) }).strict();
export const commerceReceiptSchema = z
  .object({
    invoiceNumber: optText(60),
    lines: z
      .array(
        z
          .object({
            poItemId: uuid,
            accepted: z.number().int().min(0),
            rejected: z.number().int().min(0).default(0),
            batchNumber: text(60).min(1),
            manufacturedOn: day.nullish(),
            expiresOn: day.nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
export type CommerceReceiptInput = z.infer<typeof commerceReceiptSchema>;
export const commerceSupplierPaymentSchema = z.object({ poId: uuid.nullish(), amount: positiveMoney, paidOn: day, reference: optText(80) }).strict();

export const commerceListQuerySchema = z
  .object({
    q: text(120).optional(),
    status: text(30).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();
export type CommerceListQuery = z.infer<typeof commerceListQuerySchema>;
export const commerceMarkTestDataSchema = z.object({ productIds: z.array(z.string().min(1).max(60)).min(1).max(200), isTestData: z.boolean() }).strict();

// ---------- DTOs ----------

export type CommerceAvailability = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
export interface CommerceProductDto {
  listingId: string;
  productId: string;
  name: string;
  brand: string | null;
  category: string | null;
  variant: string | null;
  description: string | null;
  imageUrl: string | null;
  sellerName: string;
  mrp: string;
  price: string;
  discountPercent: number | null;
  availability: CommerceAvailability;
  availableQuantity: number;
  maxPerOrder: number;
  codEligible: boolean;
  returnable: boolean;
  returnWindowDays: number;
  /** Published reviews of real purchases; absent until there is one. */
  rating?: { average: number; count: number };
}
export interface CommercePageDto<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface CommerceHomeDto {
  featured: CommerceProductDto[];
  bestSellers: CommerceProductDto[];
  newArrivals: CommerceProductDto[];
  offers: CommerceProductDto[];
  categories: Array<{ name: string; products: number }>;
  brands: Array<{ name: string; products: number }>;
}
export interface CommerceServiceabilityDto {
  pincode: string;
  serviceable: boolean;
  deliveryCharge: string | null;
  freeAbove: string | null;
  minDays: number | null;
  maxDays: number | null;
  cod: boolean;
  message: string;
}
export interface CommerceQuoteDto {
  lines: Array<{ listingId: string; productId: string; name: string; brand: string | null; variant: string | null; quantity: number; mrp: string; unitPrice: string; lineTotal: string; availableQuantity: number; maxPerOrder: number; problem: string | null }>;
  subtotal: string;
  savings: string;
  discountTotal: string;
  /** Automatic offers, already inside discountTotal. */
  promotions?: Array<{ name: string; amount: string }>;
  couponCode: string | null;
  couponMessage: string | null;
  deliveryCharge: string | null;
  taxIncluded: string;
  total: string;
  serviceability: CommerceServiceabilityDto | null;
  blocking: string[];
}
export interface CommerceOrderDto {
  id: string;
  orderNumber: string;
  checkoutNumber: string;
  sellerName: string;
  sellerType: "FASTQUE";
  status: CommerceOrderStatus;
  statusLabel: string;
  paymentMethod: string;
  paymentStatus: CommercePaymentStatus;
  paymentLabel: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  shippingAddress: CommerceAddressInput;
  instructions: string | null;
  items: Array<{ id: string; productId: string; name: string; brand: string | null; variant: string | null; sku: string; hsnCode: string | null; gstRatePercent: string | null; quantity: number; mrp: string; unitPrice: string; lineTotal: string; returnableUntil: string | null; returnableQuantity: number }>;
  subtotal: string;
  discountTotal: string;
  promotions?: Array<{ name: string; amount: string }>;
  couponCode: string | null;
  deliveryCharge: string;
  taxIncluded: string;
  total: string;
  amountDue: string;
  expectedFrom: string;
  expectedTo: string;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  events: Array<{ toStatus: CommerceOrderStatus; label: string; note: string | null; at: string }>;
  shipment: { courier: string; trackingNumber: string | null; trackingUrl: string | null; expectedOn: string | null; manual: boolean } | null;
  returns: Array<{ id: string; number: string; status: CommerceReturnStatus; reason: string; resolution: string; adminNote: string | null; createdAt: string; items: Array<{ id: string; orderItemId: string; quantity: number; disposition: string | null }> }>;
  allowedTransitions: CommerceOrderStatus[];
}
export interface CommerceCheckoutResultDto {
  checkoutNumber: string;
  created: boolean;
  fastque: { orderNumber: string; accessToken: string; total: string } | null;
  salons: Array<{ orderNumber: string; accessToken: string; salonName: string; total: string }>;
}
