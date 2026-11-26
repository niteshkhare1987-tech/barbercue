import { z } from "zod";
import { paise } from "./commerce";

// FastQue Direct Commerce, second part: reviews, support, automatic offers, product details, imports,
// audits, procurement and forecasting rules. Pure functions here; the server decides everything.

// ---------- Automatic offers ----------

export const COMMERCE_PROMOTION_KINDS = ["BUY_X_GET_Y", "BUNDLE", "PERCENT"] as const;
export interface PromotionRule {
  id: string;
  name: string;
  kind: string;
  listingIds: string[];
  buyQty: number;
  getQty: number;
  value: string;
  pinRules: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
}
export interface PromotionLine {
  listingId: string;
  quantity: number;
  unitPaise: number;
}
export interface AppliedPromotion {
  id: string;
  name: string;
  amountPaise: number;
  /** Discount per listing, so tax and coupons can be worked out per line. */
  perListing: Record<string, number>;
}

/** Shares `amount` across weights exactly (largest remainder on the last line). */
export function splitPaise(amount: number, weights: number[]): number[] {
  const total = weights.reduce((n, w) => n + w, 0);
  let left = amount;
  return weights.map((w, i) => {
    const share = i === weights.length - 1 ? left : total ? Math.floor((amount * w) / total) : 0;
    left -= share;
    return share;
  });
}

export function promotionLive(p: PromotionRule, pin: string | undefined, now: Date): boolean {
  if (!p.isActive || (p.startsAt && now < p.startsAt) || (p.endsAt && now >= p.endsAt)) return false;
  return !p.pinRules.length || (!!pin && p.pinRules.some((r) => pin.startsWith(r)));
}

function one(p: PromotionRule, lines: PromotionLine[]): AppliedPromotion | null {
  const mine = lines.filter((l) => p.listingIds.includes(l.listingId));
  const perListing: Record<string, number> = {};
  if (p.kind === "BUY_X_GET_Y") {
    const set = p.buyQty + p.getQty;
    if (p.getQty < 1) return null;
    for (const l of mine) {
      const free = Math.floor(l.quantity / set) * p.getQty;
      if (free) perListing[l.listingId] = free * l.unitPaise;
    }
  } else if (p.kind === "PERCENT") {
    for (const l of mine) {
      const d = Math.floor((l.unitPaise * l.quantity * Number(p.value)) / 100);
      if (d > 0) perListing[l.listingId] = d;
    }
  } else if (p.kind === "BUNDLE") {
    if (p.listingIds.length < 2 || mine.length < p.listingIds.length) return null;
    const sets = Math.min(...mine.map((l) => l.quantity));
    const normal = mine.reduce((n, l) => n + l.unitPaise, 0);
    const off = (normal - paise(p.value)) * sets;
    if (off <= 0) return null;
    splitPaise(off, mine.map((l) => l.unitPaise)).forEach((d, i) => (perListing[mine[i].listingId] = d));
  }
  const amountPaise = Object.values(perListing).reduce((n, d) => n + d, 0);
  return amountPaise > 0 ? { id: p.id, name: p.name, amountPaise, perListing } : null;
}

/** Best saving first; a product is only ever in one offer, so offers never stack. */
export function applyPromotions(promos: readonly PromotionRule[], lines: PromotionLine[], pin: string | undefined, now: Date): AppliedPromotion[] {
  const out: AppliedPromotion[] = [];
  const live = promos.filter((p) => promotionLive(p, pin, now));
  let free = lines;
  for (;;) {
    const best = live
      .filter((p) => !out.some((o) => o.id === p.id))
      .map((p) => one(p, free))
      .filter((a): a is AppliedPromotion => !!a)
      .sort((a, b) => b.amountPaise - a.amountPaise || a.id.localeCompare(b.id))[0];
    if (!best) return out;
    out.push(best);
    free = free.filter((l) => !(l.listingId in best.perListing));
  }
}

// ---------- Demand forecast (a transparent statistic, not a prediction model) ----------

export interface DemandForecast {
  weeklyAverage: number;
  low: number;
  high: number;
  weeksOfHistory: number;
  basis: string;
}
export const FORECAST_MIN_WEEKS = 4;
/**
 * Weekly units, oldest first. Recent weeks count more (weights 1..n); the range is the average plus or
 * minus one standard deviation. Null when there is not enough history, rather than a guess.
 */
export function forecastDemand(weekly: number[]): DemandForecast | null {
  const first = weekly.findIndex((w) => w > 0);
  const used = first < 0 ? [] : weekly.slice(first);
  if (used.length < FORECAST_MIN_WEEKS || used.filter((w) => w > 0).length < 2) return null;
  const weights = used.map((_, i) => i + 1);
  const sum = weights.reduce((n, w) => n + w, 0);
  const avg = used.reduce((n, u, i) => n + u * weights[i], 0) / sum;
  const sd = Math.sqrt(used.reduce((n, u, i) => n + weights[i] * (u - avg) ** 2, 0) / sum);
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    weeklyAverage: r(avg),
    low: r(Math.max(0, avg - sd)),
    high: r(avg + sd),
    weeksOfHistory: used.length,
    basis: `Weighted average of the last ${used.length} weeks of orders (${used.join(", ")}); recent weeks count more. Range is one standard deviation.`,
  };
}

// ---------- Spreadsheet imports ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const STOCK_IMPORT_COLUMNS = {
  code: ["sku", "barcode", "ean", "productcode", "skuorbarcode"],
  warehouse: ["warehouse", "warehousecode"],
  batch: ["batch", "batchnumber", "batchno", "lot"],
  manufacturedOn: ["mfg", "mfgdate", "manufactured", "manufacturedon", "manufacturingdate"],
  expiresOn: ["expiry", "expirydate", "expires", "expireson", "exp"],
  unitCost: ["cost", "unitcost", "purchaseprice", "costprice"],
  quantity: ["qty", "quantity", "units"],
} as const;
export const SETTLEMENT_COLUMNS = {
  match: ["order", "orderno", "ordernumber", "orderid", "tracking", "trackingno", "trackingnumber", "awb", "awbno", "awbnumber"],
  amount: ["amount", "cod", "codamount", "collected", "collectedamount"],
  deductions: ["deductions", "deduction", "charges", "fee", "fees", "codfee"],
  reference: ["reference", "utr", "remittanceid", "bankreference", "txnid"],
} as const;
/** Column index per field from the header row; missing fields are absent. */
export function mapColumns<K extends string>(header: string[], spec: Record<K, readonly string[]>): Partial<Record<K, number>> {
  const heads = header.map(norm);
  const out: Partial<Record<K, number>> = {};
  for (const k of Object.keys(spec) as K[]) {
    const at = heads.findIndex((h) => spec[k].includes(h));
    if (at >= 0) out[k] = at;
  }
  return out;
}
/** 2027-03-31, 31/03/2027, 31-03-2027 or an Excel day number; null when unreadable. */
export function parseSheetDate(raw: string): string | null {
  const v = raw.trim();
  const make = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  if (m) return make(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (m) return make(+m[3], +m[2], +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86400_000).toISOString().slice(0, 10);
  return null;
}
export function parseSheetMoney(raw: string): string | null {
  const v = raw.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  return /^\d{1,9}(\.\d+)?$/.test(v) ? (Math.round(Number(v) * 100) / 100).toFixed(2) : null;
}

// ---------- Schemas ----------

const uuid = z.string().uuid();
const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Enter an amount like 499 or 499.50");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const opt = (max: number) => z.string().trim().max(max).nullish();
const when = z.string().datetime().nullish();
const pins = z.array(z.string().regex(/^\d{1,6}$/)).max(500).default([]);

export const commerceReviewSchema = z.object({ orderItemId: uuid, rating: z.number().int().min(1).max(5), body: opt(1500), displayName: text(2, 60) }).strict();
export type CommerceReviewInput = z.infer<typeof commerceReviewSchema>;
export const commerceReviewModerateSchema = z.object({ status: z.enum(["PUBLISHED", "HIDDEN"]), reply: opt(1000) }).strict();
export interface CommerceReviewDto {
  id: string;
  displayName: string;
  rating: number;
  body: string | null;
  reply: string | null;
  createdAt: string;
  verifiedPurchase: true;
}
export interface CommerceReviewsDto {
  average: number | null;
  count: number;
  stars: Record<string, number>;
  items: CommerceReviewDto[];
}

export const COMMERCE_TICKET_CATEGORIES = ["DELIVERY", "PRODUCT", "RETURN_REFUND", "PAYMENT", "CANCELLATION", "INVOICE", "OTHER"] as const;
export const COMMERCE_TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"] as const;
export const commerceTicketSchema = z.object({ category: z.enum(COMMERCE_TICKET_CATEGORIES), subject: text(3, 160), body: text(3, 3000), orderItemId: uuid.optional() }).strict();
export type CommerceTicketInput = z.infer<typeof commerceTicketSchema>;
export const commerceTicketReplySchema = z.object({ body: text(1, 3000) }).strict();
export const commerceTicketStaffSchema = z
  .object({ body: z.string().trim().max(3000).optional(), internal: z.boolean().default(false), status: z.enum(COMMERCE_TICKET_STATUSES).optional(), priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(), assignToMe: z.boolean().optional() })
  .strict();
export type CommerceTicketStaffInput = z.infer<typeof commerceTicketStaffSchema>;
export interface CommerceTicketDto {
  id: string;
  number: string;
  orderNumber: string;
  productName: string | null;
  category: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ id: string; from: "CUSTOMER" | "STAFF"; body: string; internal: boolean; createdAt: string }>;
}

export const commercePromotionSchema = z
  .object({
    name: text(3, 80),
    kind: z.enum(COMMERCE_PROMOTION_KINDS),
    listingIds: z.array(uuid).min(1).max(100),
    buyQty: z.number().int().min(1).max(20).default(1),
    getQty: z.number().int().min(0).max(20).default(0),
    value: money.default("0"),
    pinRules: pins,
    startsAt: when,
    endsAt: when,
    isActive: z.boolean().default(true),
    confirmBelowCost: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.kind !== "BUY_X_GET_Y" || v.getQty >= 1, { message: "Enter how many are free.", path: ["getQty"] })
  .refine((v) => v.kind !== "BUNDLE" || (new Set(v.listingIds).size >= 2 && Number(v.value) > 0), { message: "A bundle needs at least two products and a price.", path: ["value"] })
  .refine((v) => v.kind !== "PERCENT" || (Number(v.value) > 0 && Number(v.value) <= 90), { message: "Enter 1–90%.", path: ["value"] });
export type CommercePromotionInput = z.infer<typeof commercePromotionSchema>;

export const commerceListingDetailSchema = z
  .object({ ingredients: opt(4000), usage: opt(2000), benefits: opt(2000), warnings: opt(2000), countryOfOrigin: opt(60), manufacturer: opt(300), shelfLifeMonths: z.number().int().min(1).max(240).nullish(), variantGroup: opt(60), variantLabel: opt(60) })
  .strict();
export type CommerceListingDetailInput = z.infer<typeof commerceListingDetailSchema>;
export const commerceBannerSchema = z
  .object({
    title: text(2, 100),
    subtitle: opt(200),
    imageUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "Use an https link").nullish(),
    linkPath: z.string().trim().regex(/^\/shop(\/[\w\-/]*)?(\?[\w\-=&%+.]*)?$/, "Use a page inside the shop, such as /shop/fastque").max(200),
    sortOrder: z.number().int().min(1).max(1000).default(100),
    startsAt: when,
    endsAt: when,
    isActive: z.boolean().default(true),
  })
  .strict();
export interface CommerceBannerDto {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  linkPath: string;
}
export const commerceReturnPolicySchema = z.object({ category: text(1, 80), returnable: z.boolean(), windowDays: z.number().int().min(0).max(60), note: opt(300) }).strict();
export const commerceSavedBagSchema = z.object({ items: z.array(z.object({ listingId: uuid, quantity: z.number().int().min(1).max(50) }).strict()).max(50) }).strict();
export const COMMERCE_METRICS = ["PRODUCT_VIEW", "BAG_VIEW", "CHECKOUT_START"] as const;
export const commerceMetricSchema = z.object({ metric: z.enum(COMMERCE_METRICS) }).strict();
export const commerceIdsQuerySchema = z.object({ ids: z.string().regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,19}$/) }).strict();

export const commerceBulkTransitionSchema = z
  .object({ orderIds: z.array(uuid).min(1).max(100), to: z.enum(["CONFIRMED", "PROCESSING", "PACKED", "OUT_FOR_DELIVERY"]) })
  .strict();
export const commerceWarehouseGrantSchema = z.object({ userId: z.string().min(1).max(60), warehouseIds: z.array(uuid).max(100) }).strict();
export const commerceAuditSchema = z.object({ warehouseId: uuid, q: z.string().trim().max(120).optional() }).strict();
export const commerceAuditCountSchema = z.object({ lines: z.array(z.object({ batchId: uuid, counted: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(2000) }).strict();
export const commercePurchaseRequestSchema = z.object({ listingId: uuid, warehouseId: uuid, quantity: z.number().int().min(1).max(1_000_000), reason: text(3, 300) }).strict();
export const commerceQuotationSchema = z.object({ supplierId: uuid, unitCost: money.refine((v) => Number(v) > 0, "Must be more than 0"), leadTimeDays: z.number().int().min(0).max(365).nullish(), validUntil: day.nullish(), note: opt(300) }).strict();
export const commerceRequestActionSchema = z.object({ action: z.enum(["APPROVE", "REJECT", "ORDER"]), quotationId: uuid.optional() }).strict();
export const commerceSupplierReturnSchema = z.object({ supplierId: uuid, batchId: uuid, source: z.enum(["ON_HAND", "DAMAGED", "QUARANTINED", "EXPIRED"]), quantity: z.number().int().min(1).max(1_000_000), reason: text(3, 300) }).strict();
export type CommerceSupplierReturnInput = z.infer<typeof commerceSupplierReturnSchema>;
export const commerceSupplierCreditSchema = z.object({ amount: money, reference: opt(80) }).strict();
export const commercePickupSchema = z.object({ warehouseId: uuid, courier: text(2, 80), pickupOn: day, window: opt(40), orderIds: z.array(uuid).min(1).max(200), note: opt(300) }).strict();
export const commercePickupActionSchema = z.object({ status: z.enum(["PICKED_UP", "CANCELLED"]) }).strict();
