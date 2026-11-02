import { z } from "zod";
import { parseCsv } from "./product-catalog";

/**
 * Inventory Phases 4–5 — B2B and B2C commerce. Suppliers (FastQue-approved) sell to salons through
 * purchase orders; salons sell stock they hold to other salons (B2B listings) and to customers for
 * pickup (B2C listings). Every listing and supplier is approved by a FastQue admin first. Payment is
 * settled at the salon (cash/UPI at pickup, or the salon's own UPI QR) or on the supplier's invoice
 * — FastQue never takes money here. Stock changes only through the inventory ledger, exactly once.
 */

// ---------- Paths ----------

export const COMMERCE_PATHS = {
  /** Salon-scoped, under dashboard/salons/:salonId/inventory/ */
  purchaseOrders: "purchase-orders",
  place: "place",
  cancel: "cancel",
  receive: "receive",
  invoice: "invoice",
  compare: "compare-suppliers",
  linkSupplier: "link-marketplace-supplier",
  listings: "listings",
  pause: "pause",
  resume: "resume",
  end: "end",
  sales: "sales",
  purchases: "marketplace-purchases",
  accept: "accept",
  ready: "ready",
  dispatch: "dispatch",
  complete: "complete",
  confirmReceipt: "confirm-receipt",
  markPaid: "mark-paid",
  dispute: "dispute",
  returnDecision: "return-decision",
  /** Salon buyer browsing salon-to-salon listings: dashboard/salons/:salonId/inventory/salon-market */
  salonMarket: "salon-market",
  /** Supplier portal, under supplier/ */
  supplierRoot: "supplier",
  apply: "apply",
  me: "me",
  offers: "offers",
  offersImportPreview: "offers/import/preview",
  offersImportCommit: "offers/import/commit",
  supplierOrders: "orders",
  confirm: "confirm",
  reject: "reject",
  /** Public / customer, under shop/ */
  shopRoot: "shop",
  products: "products",
  orders: "orders",
  requestReturn: "return",
  /** Admin, under admin/ */
  adminSuppliers: "marketplace-suppliers",
  adminListings: "marketplace-listings",
  adminOrders: "marketplace-orders",
  review: "review",
  resolve: "resolve",
} as const;

export const CommerceErrorCode = {
  SUPPLIER_NOT_APPROVED: "COMMERCE_SUPPLIER_NOT_APPROVED",
  NOT_A_SUPPLIER: "COMMERCE_NOT_A_SUPPLIER",
  ALREADY_APPLIED: "COMMERCE_ALREADY_APPLIED",
  OFFER_INVALID: "COMMERCE_OFFER_INVALID",
  PO_INVALID: "COMMERCE_PURCHASE_ORDER_INVALID",
  PO_TRANSITION: "COMMERCE_PURCHASE_ORDER_TRANSITION",
  RECEIPT_INVALID: "COMMERCE_RECEIPT_INVALID",
  LISTING_NOT_ELIGIBLE: "COMMERCE_LISTING_NOT_ELIGIBLE",
  LISTING_UNAVAILABLE: "COMMERCE_LISTING_UNAVAILABLE",
  NOT_ENOUGH_AVAILABLE: "COMMERCE_NOT_ENOUGH_AVAILABLE",
  ORDER_TRANSITION: "COMMERCE_ORDER_TRANSITION",
  PICKUP_CODE: "COMMERCE_PICKUP_CODE",
  NOT_FOUND: "COMMERCE_NOT_FOUND",
  OWN_LISTING: "COMMERCE_OWN_LISTING",
} as const;

// ---------- Statuses and transitions ----------

export const SupplierStatus = { PENDING: "PENDING", APPROVED: "APPROVED", REJECTED: "REJECTED", SUSPENDED: "SUSPENDED" } as const;
export type SupplierStatus = (typeof SupplierStatus)[keyof typeof SupplierStatus];

export const PurchaseOrderStatus = {
  DRAFT: "DRAFT",
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  DISPATCHED: "DISPATCHED",
  PARTIALLY_RECEIVED: "PARTIALLY_RECEIVED",
  RECEIVED: "RECEIVED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
} as const;
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];

/** Who may move a purchase order where. Receiving is its own action (any open status after placing). */
export const PO_TRANSITIONS: Record<"SALON" | "SUPPLIER", Partial<Record<PurchaseOrderStatus, PurchaseOrderStatus[]>>> = {
  SALON: { DRAFT: ["PLACED", "CANCELLED"], PLACED: ["CANCELLED"], CONFIRMED: ["CANCELLED"] },
  SUPPLIER: { PLACED: ["CONFIRMED", "REJECTED"], CONFIRMED: ["DISPATCHED", "REJECTED"] },
};
export const PO_RECEIVABLE: readonly PurchaseOrderStatus[] = ["PLACED", "CONFIRMED", "DISPATCHED", "PARTIALLY_RECEIVED"];

export const ListingChannel = { SALON: "SALON", CUSTOMER: "CUSTOMER" } as const;
export type ListingChannel = (typeof ListingChannel)[keyof typeof ListingChannel];
export const ListingStatus = {
  PENDING_REVIEW: "PENDING_REVIEW",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  REJECTED: "REJECTED",
  ENDED: "ENDED",
} as const;
export type ListingStatus = (typeof ListingStatus)[keyof typeof ListingStatus];

export const MarketOrderStatus = {
  PLACED: "PLACED",
  ACCEPTED: "ACCEPTED",
  READY_FOR_PICKUP: "READY_FOR_PICKUP",
  DISPATCHED: "DISPATCHED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  RETURN_REQUESTED: "RETURN_REQUESTED",
  RETURNED: "RETURNED",
  DISPUTED: "DISPUTED",
} as const;
export type MarketOrderStatus = (typeof MarketOrderStatus)[keyof typeof MarketOrderStatus];

/** Order states that still hold a reservation on the listing. */
export const RESERVING_ORDER_STATUSES: readonly MarketOrderStatus[] = ["PLACED", "ACCEPTED", "READY_FOR_PICKUP"];

type Actor = "BUYER" | "SELLER" | "SYSTEM" | "ADMIN";
/** The whole order lifecycle. Customer orders go via READY_FOR_PICKUP, salon orders via DISPATCHED. */
export const ORDER_TRANSITIONS: ReadonlyArray<{ from: MarketOrderStatus; to: MarketOrderStatus; by: Actor[]; channel?: ListingChannel }> = [
  { from: "PLACED", to: "ACCEPTED", by: ["SELLER"] },
  { from: "PLACED", to: "CANCELLED", by: ["BUYER", "SELLER"] },
  { from: "PLACED", to: "EXPIRED", by: ["SYSTEM"] },
  { from: "ACCEPTED", to: "READY_FOR_PICKUP", by: ["SELLER"], channel: "CUSTOMER" },
  { from: "ACCEPTED", to: "DISPATCHED", by: ["SELLER"], channel: "SALON" },
  { from: "ACCEPTED", to: "CANCELLED", by: ["SELLER"] },
  { from: "READY_FOR_PICKUP", to: "COMPLETED", by: ["SELLER"], channel: "CUSTOMER" },
  { from: "READY_FOR_PICKUP", to: "CANCELLED", by: ["SELLER"] },
  { from: "READY_FOR_PICKUP", to: "EXPIRED", by: ["SYSTEM"] },
  { from: "DISPATCHED", to: "COMPLETED", by: ["BUYER"], channel: "SALON" },
  { from: "DISPATCHED", to: "DISPUTED", by: ["BUYER"], channel: "SALON" },
  { from: "COMPLETED", to: "RETURN_REQUESTED", by: ["BUYER"], channel: "CUSTOMER" },
  { from: "RETURN_REQUESTED", to: "RETURNED", by: ["SELLER"] },
  { from: "RETURN_REQUESTED", to: "COMPLETED", by: ["SELLER"] },
  { from: "DISPUTED", to: "COMPLETED", by: ["ADMIN"] },
  { from: "DISPUTED", to: "CANCELLED", by: ["ADMIN"] },
];

export function canTransition(from: MarketOrderStatus, to: MarketOrderStatus, by: Actor, channel: ListingChannel): boolean {
  return ORDER_TRANSITIONS.some((t) => t.from === from && t.to === to && t.by.includes(by) && (!t.channel || t.channel === channel));
}

/** A seller has 48 hours to accept; a customer has 7 days to collect; returns within 7 days. */
export const ORDER_ACCEPT_HOURS = 48;
export const PICKUP_DAYS = 7;
export const RETURN_DAYS = 7;
/** Listings must not expire within this many days. */
export const LISTING_MIN_SHELF_DAYS = 30;

export const PaymentMethod = { PAY_AT_PICKUP: "PAY_AT_PICKUP", UPI_TO_SALON: "UPI_TO_SALON", INVOICE: "INVOICE" } as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

// ---------- Pure rules ----------

export interface ListingEligibilityInput {
  channel: ListingChannel;
  quantity: number;
  stockOnHand: number;
  /** Quantity already promised on this product's other open listings. */
  alreadyListed: number;
  productActive: boolean;
  catalogVerified: boolean;
  productType: "PROFESSIONAL" | "RETAIL" | "BOTH" | null;
  sealed: boolean;
  photoCount: number;
  expiryDate: string | null;
  today: string;
  hasProvenance: boolean;
}

/** Every reason a listing can't be submitted (empty = eligible for admin review). */
export function listingProblems(i: ListingEligibilityInput): string[] {
  const out: string[] = [];
  if (!i.productActive) out.push("This product is not in use any more.");
  if (!i.catalogVerified) out.push("Only products verified in the FastQue catalog can be sold.");
  if (i.channel === "CUSTOMER" && i.productType === "PROFESSIONAL") out.push("This product is for professional use only and can't be sold to customers.");
  if (!i.sealed) out.push("Only sealed, unopened stock can be sold.");
  if (i.photoCount < 1) out.push("Add at least one photo of the actual stock.");
  if (i.channel === "SALON" && !i.hasProvenance) out.push("Add the purchase invoice (photo) or where the stock came from.");
  if (!Number.isInteger(i.quantity) || i.quantity < 1) out.push("List a whole number of items.");
  const free = i.stockOnHand - i.alreadyListed;
  if (i.quantity > free) out.push(`Only ${Math.max(0, Math.floor(free))} available to list (stock not already listed).`);
  if (i.expiryDate) {
    const days = Math.round((Date.parse(`${i.expiryDate}T12:00:00Z`) - Date.parse(`${i.today}T12:00:00Z`)) / 864e5);
    if (days < LISTING_MIN_SHELF_DAYS) out.push(`Stock must have at least ${LISTING_MIN_SHELF_DAYS} days before it expires.`);
  }
  return out;
}

export interface SupplierQuoteInput {
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  minOrderQuantity: number;
  availableQuantity: number | null;
  leadTimeDays: number;
  deliveryCharge: number;
  freeDeliveryAbove: number | null;
}

export interface SupplierQuote extends SupplierQuoteInput {
  orderQuantity: number;
  itemsTotal: number;
  delivery: number;
  total: number;
  /** null = the supplier didn't say how much they have. */
  canSupply: boolean | null;
}

/** Prices a quantity at each supplier (minimum order applied), cheapest total first. */
export function compareSuppliers(quantity: number, offers: SupplierQuoteInput[]): SupplierQuote[] {
  return offers
    .map((o) => {
      const orderQuantity = Math.max(Math.ceil(quantity), o.minOrderQuantity);
      const itemsTotal = Math.round(orderQuantity * o.unitPrice * 100) / 100;
      const delivery = o.freeDeliveryAbove != null && itemsTotal >= o.freeDeliveryAbove ? 0 : o.deliveryCharge;
      return {
        ...o,
        orderQuantity,
        itemsTotal,
        delivery,
        total: Math.round((itemsTotal + delivery) * 100) / 100,
        canSupply: o.availableQuantity == null ? null : o.availableQuantity >= orderQuantity,
      };
    })
    .sort((a, b) => Number(b.canSupply !== false) - Number(a.canSupply !== false) || a.total - b.total || a.leadTimeDays - b.leadTimeDays);
}

/** A 6-digit pickup code the customer shows at the salon. */
export function newPickupCode(random: () => number = Math.random): string {
  return String(Math.floor(random() * 1_000_000)).padStart(6, "0");
}

// ---------- Schemas ----------

const money = z.number().finite().nonnegative().max(9999999.99).multipleOf(0.01);
const positiveMoney = money.refine((v) => v > 0, "Must be above 0");
const qty = z.number().finite().positive().max(999999).multipleOf(0.001);
const wholeQty = z.number().int().positive().max(100000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).optional().nullable();
const url = z.string().trim().url().max(500);

export const supplierApplicationSchema = z
  .object({
    name: text(120),
    legalName: optional(160),
    gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, "GSTIN is 15 letters and digits").optional().nullable(),
    contactName: text(120),
    phone: z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, "Enter a phone number"),
    email: z.string().trim().toLowerCase().email().max(254),
    address: text(300),
    cityId: z.string().uuid(),
    serviceCityIds: z.array(z.string().uuid()).min(1).max(50),
    defaultLeadTimeDays: z.number().int().min(0).max(60),
    deliveryCharge: money,
    freeDeliveryAbove: money.optional().nullable(),
    minimumOrderValue: money.optional().nullable(),
  })
  .strict();
export type SupplierApplicationInput = z.infer<typeof supplierApplicationSchema>;
export const updateSupplierProfileSchema = supplierApplicationSchema.omit({ name: true, gstin: true, legalName: true }).partial().strict();
export type UpdateSupplierProfileInput = z.infer<typeof updateSupplierProfileSchema>;

export const supplierOfferSchema = z
  .object({
    globalProductId: z.string().uuid(),
    supplierSku: optional(60),
    unitPrice: positiveMoney,
    minOrderQuantity: z.number().int().min(1).max(100000).default(1),
    /** null = not shared; the salon is told availability is unconfirmed. */
    availableQuantity: z.number().int().min(0).max(10000000).optional().nullable(),
    leadTimeDays: z.number().int().min(0).max(60).optional().nullable(),
    isActive: z.boolean().default(true),
  })
  .strict();
export type SupplierOfferInput = z.infer<typeof supplierOfferSchema>;

export const SUPPLIER_OFFER_CSV_COLUMNS = ["barcode", "supplier_sku", "price", "min_order", "available", "lead_time_days"] as const;
export const SUPPLIER_OFFER_CSV_MAX_ROWS = 2000;

export interface OfferCsvRow {
  line: number;
  barcode: string;
  status: "OK" | "INVALID" | "UNKNOWN_PRODUCT" | "DUPLICATE_IN_FILE";
  errors: string[];
  offer?: { supplierSku: string | null; unitPrice: number; minOrderQuantity: number; availableQuantity: number | null; leadTimeDays: number | null };
}

/** Validates a supplier's price list CSV. `known` maps a normalised barcode → catalog product id. */
export function validateOfferCsv(csv: string, normalize: (raw: string) => string | null, known: Map<string, string>): { headerErrors: string[]; rows: (OfferCsvRow & { globalProductId?: string })[] } {
  const grid = parseCsv(csv);
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const headerErrors: string[] = [];
  for (const col of ["barcode", "price"]) if (!header.includes(col)) headerErrors.push(`Missing the "${col}" column.`);
  const unknown = header.filter((h) => h && !(SUPPLIER_OFFER_CSV_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) headerErrors.push(`Unknown columns: ${unknown.join(", ")}.`);
  if (grid.length - 1 > SUPPLIER_OFFER_CSV_MAX_ROWS) headerErrors.push(`At most ${SUPPLIER_OFFER_CSV_MAX_ROWS} rows per file.`);
  if (headerErrors.length) return { headerErrors, rows: [] };
  const col = (r: string[], name: string) => (header.indexOf(name) >= 0 ? (r[header.indexOf(name)] ?? "").trim() : "");
  const seen = new Map<string, number>();
  const rows = grid.slice(1).map((r, i) => {
    const line = i + 2;
    const raw = col(r, "barcode");
    const errors: string[] = [];
    const code = normalize(raw);
    if (!code) errors.push("Barcode is not valid.");
    const price = Number(col(r, "price").replace(/[₹,\s]/g, ""));
    if (!(price > 0)) errors.push("Price must be a number above 0.");
    const intOr = (name: string, fallback: number | null) => {
      const v = col(r, name);
      if (!v) return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        errors.push(`${name.replace(/_/g, " ")} must be a whole number.`);
        return fallback;
      }
      return n;
    };
    const minOrder = intOr("min_order", 1) ?? 1;
    const available = intOr("available", null);
    const lead = intOr("lead_time_days", null);
    if (minOrder < 1) errors.push("min order must be at least 1.");
    if (errors.length) return { line, barcode: raw, status: "INVALID" as const, errors };
    if (seen.has(code!)) return { line, barcode: raw, status: "DUPLICATE_IN_FILE" as const, errors: [`Same barcode as line ${seen.get(code!)}.`] };
    seen.set(code!, line);
    const globalProductId = known.get(code!);
    if (!globalProductId) return { line, barcode: raw, status: "UNKNOWN_PRODUCT" as const, errors: ["Not a verified product in the FastQue catalog yet. Ask FastQue to add it."] };
    return {
      line,
      barcode: raw,
      status: "OK" as const,
      errors: [],
      globalProductId,
      offer: { supplierSku: col(r, "supplier_sku") || null, unitPrice: Math.round(price * 100) / 100, minOrderQuantity: minOrder, availableQuantity: available, leadTimeDays: lead },
    };
  });
  return { headerErrors, rows };
}

export const createPurchaseOrderSchema = z
  .object({
    marketplaceSupplierId: z.string().uuid().optional().nullable(),
    inventorySupplierId: z.string().uuid().optional().nullable(),
    notes: optional(500),
    items: z
      .array(
        z
          .object({
            inventoryProductId: z.string().uuid().optional().nullable(),
            globalProductId: z.string().uuid().optional().nullable(),
            quantity: qty,
            unitPrice: money,
          })
          .strict()
          .refine((i) => i.inventoryProductId || i.globalProductId, "Choose a product"),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((v) => !!v.marketplaceSupplierId !== !!v.inventorySupplierId, { path: ["marketplaceSupplierId"], message: "Choose one supplier" });
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

export const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export type CancelInput = z.infer<typeof cancelSchema>;

export const goodsReceiptSchema = z
  .object({
    note: optional(500),
    invoiceUrl: url.optional().nullable(),
    lines: z
      .array(
        z
          .object({
            purchaseOrderItemId: z.string().uuid(),
            quantityReceived: z.number().finite().min(0).max(999999).multipleOf(0.001),
            quantityDamaged: z.number().finite().min(0).max(999999).multipleOf(0.001).default(0),
            batchNumber: optional(60),
            expiryDate: day.optional().nullable(),
            /** The barcode scanned on the delivered goods, checked against the ordered product. */
            scannedBarcode: optional(48),
            discrepancyNote: optional(300),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type GoodsReceiptInput = z.infer<typeof goodsReceiptSchema>;

export const supplierOrderDecisionSchema = z
  .object({ note: optional(300), expectedDeliveryDate: day.optional().nullable() })
  .strict();
export type SupplierOrderDecisionInput = z.infer<typeof supplierOrderDecisionSchema>;

export const createListingSchema = z
  .object({
    inventoryProductId: z.string().uuid(),
    channel: z.nativeEnum(ListingChannel),
    quantity: wholeQty,
    unitPrice: positiveMoney,
    sealed: z.literal(true, { errorMap: () => ({ message: "Only sealed stock can be listed" }) }),
    batchNumber: optional(60),
    expiryDate: day.optional().nullable(),
    photoUrls: z.array(url).min(1).max(6),
    provenanceNote: optional(300),
    invoiceUrl: url.optional().nullable(),
    description: optional(500),
  })
  .strict();
export type CreateListingInput = z.infer<typeof createListingSchema>;

export const placeMarketOrderSchema = z
  .object({
    items: z.array(z.object({ listingId: z.string().uuid(), quantity: wholeQty }).strict()).min(1).max(20),
    paymentMethod: z.nativeEnum(PaymentMethod),
    note: optional(300),
  })
  .strict();
export type PlaceMarketOrderInput = z.infer<typeof placeMarketOrderSchema>;

export const completePickupSchema = z.object({ pickupCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), paid: z.boolean() }).strict();
export type CompletePickupInput = z.infer<typeof completePickupSchema>;

export const returnRequestSchema = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
export const returnDecisionSchema = z.object({ approve: z.boolean(), note: optional(300) }).strict();
export const disputeSchema = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
export const adminReviewSchema = z
  .object({ action: z.enum(["APPROVE", "REJECT", "SUSPEND"]), note: optional(300) })
  .strict()
  .refine((v) => v.action === "APPROVE" || !!v.note?.trim(), { path: ["note"], message: "Give a reason" });
export type AdminReviewInput = z.infer<typeof adminReviewSchema>;
export const adminResolveSchema = z.object({ outcome: z.enum(["COMPLETED", "CANCELLED"]), note: z.string().trim().min(3).max(300) }).strict();

export const shopProductQuerySchema = z
  .object({
    q: z.string().trim().max(80).optional(),
    category: z.string().trim().max(80).optional(),
    brand: z.string().trim().max(120).optional(),
    cityId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(60).default(24),
  })
  .strict();
export type ShopProductQuery = z.infer<typeof shopProductQuerySchema>;

// ---------- DTOs ----------

export interface MarketplaceSupplierDto {
  id: string;
  name: string;
  legalName: string | null;
  gstin: string | null;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  cityId: string;
  cityName: string | null;
  serviceCityIds: string[];
  defaultLeadTimeDays: number;
  deliveryCharge: string;
  freeDeliveryAbove: string | null;
  minimumOrderValue: string | null;
  status: SupplierStatus;
  reviewNote: string | null;
  offerCount: number;
  createdAt: string;
}

export interface SupplierOfferDto {
  id: string;
  globalProductId: string;
  productName: string;
  brand: string | null;
  barcode: string | null;
  imageUrl: string | null;
  supplierSku: string | null;
  unitPrice: string;
  minOrderQuantity: number;
  availableQuantity: number | null;
  leadTimeDays: number | null;
  isActive: boolean;
  updatedAt: string;
}

export interface SupplierComparisonDto {
  globalProductId: string;
  productName: string;
  quantity: number;
  quotes: (SupplierQuote & { offerId: string; deliversToShopCity: boolean; stockUpdatedAt: string })[];
}

export interface PurchaseOrderItemDto {
  id: string;
  inventoryProductId: string | null;
  globalProductId: string | null;
  name: string;
  barcode: string | null;
  quantity: string;
  unitPrice: string;
  receivedQuantity: string;
  damagedQuantity: string;
}

export interface PurchaseOrderDto {
  id: string;
  number: string;
  salonId: string;
  salonName: string;
  status: PurchaseOrderStatus;
  supplier: { kind: "MARKETPLACE" | "OWN"; id: string; name: string };
  notes: string | null;
  supplierNote: string | null;
  subtotal: string;
  deliveryCharge: string;
  total: string;
  currency: string | null;
  expectedDeliveryDate: string | null;
  invoiceUrls: string[];
  items: PurchaseOrderItemDto[];
  receipts: { id: string; receivedAt: string; note: string | null; lines: { purchaseOrderItemId: string; quantityReceived: string; quantityDamaged: string; batchNumber: string | null; expiryDate: string | null; barcodeVerified: boolean | null; discrepancyNote: string | null }[] }[];
  placedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface ListingDto {
  id: string;
  channel: ListingChannel;
  status: ListingStatus;
  salonId: string;
  salonName: string;
  cityName: string | null;
  inventoryProductId: string;
  globalProductId: string | null;
  title: string;
  brand: string | null;
  category: string | null;
  unitPrice: string;
  mrp: string | null;
  currency: string | null;
  quantityListed: number;
  quantityReserved: number;
  quantitySold: number;
  available: number;
  batchNumber: string | null;
  expiryDate: string | null;
  photoUrls: string[];
  description: string | null;
  reviewNote: string | null;
  createdAt: string;
}

export interface MarketOrderDto {
  id: string;
  number: string;
  channel: ListingChannel;
  status: MarketOrderStatus;
  seller: { salonId: string; name: string; address: string | null; cityName: string | null; phone: string | null };
  buyer: { salonId: string | null; name: string | null };
  items: { listingId: string; title: string; quantity: number; unitPrice: string; imageUrl: string | null }[];
  total: string;
  currency: string | null;
  paymentMethod: PaymentMethod;
  paid: boolean;
  /** Shown only to the customer who placed it. */
  pickupCode: string | null;
  upiQrImageUrl: string | null;
  expiresAt: string | null;
  note: string | null;
  cancelReason: string | null;
  returnReason: string | null;
  disputeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopProductDto {
  globalProductId: string;
  name: string;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  mrp: string | null;
  lowestPrice: string;
  sellerCount: number;
  currency: string | null;
}

export interface ShopProductDetailDto extends ShopProductDto {
  description: string | null;
  packSize: string | null;
  packUnit: string | null;
  offers: ListingDto[];
}
