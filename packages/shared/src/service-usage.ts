import { z } from "zod";
import { InventoryUnit } from "./inventory";

/**
 * Inventory Phase 2 — Service Consumption. Salons describe what a service uses ("Shaving: shaving
 * cream 10 ml, blade 1 piece, aftershave 5 ml") as recipe lines tied to their own inventory
 * categories; when a service is completed the barber taps the actual products used and the stock
 * is deducted through the inventory ledger, exactly once per service per visit.
 */

/** Path segments, under dashboard/salons/:salonId/inventory/ (recipes, usage report, dashboard). */
export const SERVICE_USAGE_PATHS = {
  recipes: "service-recipes",
  suggestions: "suggestions",
  visits: "service-visits",
  dashboard: "dashboard",
  /** dashboard/queue-entries/:id/product-usage — staff + owner, for one visit. */
  queueEntries: "queue-entries",
  productUsage: "product-usage",
  /** dashboard/salons/:salonId/inventory/service-usage/:usageId/reverse */
  usage: "service-usage",
  reverse: "reverse",
} as const;

export const ServiceUsageErrorCode = {
  NO_SERVICES: "SERVICE_USAGE_NO_SERVICES",
  ALREADY_RECORDED: "SERVICE_USAGE_ALREADY_RECORDED",
  NOT_FOUND: "SERVICE_USAGE_NOT_FOUND",
  ALREADY_REVERSED: "SERVICE_USAGE_ALREADY_REVERSED",
  UNIT_MISMATCH: "SERVICE_USAGE_UNIT_MISMATCH",
  NOT_YOUR_VISIT: "SERVICE_USAGE_NOT_YOUR_VISIT",
  VISIT_NOT_ACTIVE: "SERVICE_USAGE_VISIT_NOT_ACTIVE",
  INVALID_RECIPE: "SERVICE_RECIPE_INVALID",
} as const;

export const ServiceUsageStatus = { RECORDED: "RECORDED", REVERSED: "REVERSED" } as const;
export type ServiceUsageStatus = (typeof ServiceUsageStatus)[keyof typeof ServiceUsageStatus];
export const ServiceUsageSource = { MANUAL: "MANUAL", AUTO: "AUTO" } as const;
export type ServiceUsageSource = (typeof ServiceUsageSource)[keyof typeof ServiceUsageSource];

// ---------- Unit conversion ----------

type Dimension = "MASS" | "VOLUME" | "COUNT";
const UNIT_BASE: Partial<Record<InventoryUnit, { dimension: Dimension; factor: number }>> = {
  GRAM: { dimension: "MASS", factor: 1 },
  KILOGRAM: { dimension: "MASS", factor: 1000 },
  MILLILITER: { dimension: "VOLUME", factor: 1 },
  LITER: { dimension: "VOLUME", factor: 1000 },
  EACH: { dimension: "COUNT", factor: 1 },
};

/** Units a product counted in pieces/packs/boxes can describe its contents in. */
export const CONTENT_UNITS: readonly InventoryUnit[] = ["GRAM", "KILOGRAM", "MILLILITER", "LITER", "EACH"];

export interface StockUnitInfo {
  /** The unit the product's stock is counted in. */
  unit: InventoryUnit;
  /** What one counted unit contains (e.g. 1 bottle = 195 ml), when counted in EACH/PACK/BOX. */
  contentSize?: string | number | null;
  contentUnit?: InventoryUnit | null;
}

export type ConversionResult = { ok: true; quantity: number } | { ok: false; reason: string };

/** Rounds to the ledger's 3 decimals, never down to zero for a positive amount. */
function toLedger(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return value > 0 && rounded === 0 ? 0.001 : rounded;
}

/**
 * Converts an amount entered in `unit` (e.g. 10 ml) to the product's stock unit: directly within
 * the same kind of unit (ml ↔ L, g ↔ kg), or through the product's contents per piece
 * (10 ml of a 195 ml bottle counted in pieces = 0.051 pieces). Anything else is refused.
 */
export function convertToStockUnit(quantity: number, unit: InventoryUnit, product: StockUnitInfo): ConversionResult {
  if (!(quantity > 0)) return { ok: false, reason: "Enter an amount above 0." };
  if (unit === product.unit) return { ok: true, quantity: toLedger(quantity) };
  const from = UNIT_BASE[unit];
  const to = UNIT_BASE[product.unit];
  if (from && to && from.dimension === to.dimension) return { ok: true, quantity: toLedger((quantity * from.factor) / to.factor) };
  const size = product.contentSize == null ? NaN : Number(product.contentSize);
  const content = product.contentUnit ? UNIT_BASE[product.contentUnit] : undefined;
  if (from && content && from.dimension === content.dimension && size > 0) {
    return { ok: true, quantity: toLedger((quantity * from.factor) / (size * content.factor)) };
  }
  return {
    ok: false,
    reason: product.contentUnit
      ? `This product is counted in ${unitWord(product.unit)} of ${unitWord(product.contentUnit)}; use one of those units.`
      : `This product is counted in ${unitWord(product.unit)}. Set "one ${unitWord(product.unit, true)} contains" on the product to use ${unitWord(unit)}.`,
  };
}

function unitWord(unit: InventoryUnit, singular = false): string {
  const words: Record<InventoryUnit, [string, string]> = {
    EACH: ["pieces", "piece"],
    GRAM: ["grams", "gram"],
    KILOGRAM: ["kilograms", "kilogram"],
    MILLILITER: ["millilitres", "millilitre"],
    LITER: ["litres", "litre"],
    PACK: ["packs", "pack"],
    BOX: ["boxes", "box"],
    OTHER: ["units", "unit"],
  };
  return words[unit][singular ? 1 : 0];
}

// ---------- Rule-based suggestions (no AI) ----------

/**
 * Starting points for common services (from the inventory brief, Module 4): a service whose name
 * or category matches a keyword is suggested these product categories. Salons choose what to add
 * and set their own quantities — nothing here is a consumption rule by itself.
 */
export const SERVICE_CATEGORY_SUGGESTIONS: ReadonlyArray<{ keywords: readonly string[]; categories: readonly string[] }> = [
  { keywords: ["shave", "shaving", "beard"], categories: ["Shaving cream", "Blades", "Aftershave"] },
  { keywords: ["haircut", "hair cut", "trim", "styling"], categories: ["Shampoo", "Styling gel", "Hair wax"] },
  { keywords: ["colour", "color", "dye", "highlight"], categories: ["Hair colour", "Developer", "Colour treatment"] },
  { keywords: ["facial", "cleanup", "clean up"], categories: ["Cleanser", "Facial cream", "Face mask"] },
  { keywords: ["spa", "hair mask"], categories: ["Hair mask", "Conditioner", "Serum"] },
  { keywords: ["wash", "shampoo"], categories: ["Shampoo", "Conditioner"] },
  { keywords: ["manicure"], categories: ["Nail polish", "Nail polish remover", "Nail treatment"] },
  { keywords: ["pedicure"], categories: ["Foot scrub", "Foot cream", "Nail treatment"] },
];

/** Suggested product categories for a service, by its name and category (most specific first). */
export function suggestCategoriesForService(service: { name: string; category?: string | null }): string[] {
  const text = `${service.name} ${service.category ?? ""}`.toLowerCase();
  const out: string[] = [];
  for (const rule of SERVICE_CATEGORY_SUGGESTIONS) {
    if (rule.keywords.some((k) => text.includes(k))) for (const c of rule.categories) if (!out.includes(c)) out.push(c);
  }
  return out;
}

// ---------- Schemas ----------

const amount = z.number().finite().positive().max(999999.999).multipleOf(0.001);

export const serviceRecipeLineSchema = z
  .object({
    inventoryCategoryId: z.string().uuid(),
    quantity: amount,
    unit: z.nativeEnum(InventoryUnit),
    defaultProductId: z.string().uuid().optional().nullable(),
    /** Salon-approved: deduct the default product automatically when the service is completed. */
    autoDeduct: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !v.autoDeduct || !!v.defaultProductId, { path: ["autoDeduct"], message: "Choose a default product to deduct automatically." });

export const putServiceRecipeSchema = z
  .object({
    lines: z.array(serviceRecipeLineSchema).max(20),
  })
  .strict()
  .refine((v) => new Set(v.lines.map((l) => l.inventoryCategoryId)).size === v.lines.length, {
    path: ["lines"],
    message: "Each product category can appear once per service.",
  });
export type PutServiceRecipeInput = z.infer<typeof putServiceRecipeSchema>;

export const recordServiceUsageSchema = z
  .object({
    services: z
      .array(
        z
          .object({
            serviceId: z.string().uuid(),
            items: z
              .array(
                z
                  .object({
                    productId: z.string().uuid(),
                    quantity: amount,
                    unit: z.nativeEnum(InventoryUnit),
                    ruleId: z.string().uuid().optional().nullable(),
                  })
                  .strict(),
              )
              .min(1)
              .max(30),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine((v) => new Set(v.services.map((s) => s.serviceId)).size === v.services.length, {
    path: ["services"],
    message: "Each service can appear once.",
  })
  .refine((v) => v.services.every((s) => new Set(s.items.map((i) => i.productId)).size === s.items.length), {
    path: ["services"],
    message: "Pick each product once per service; change its amount instead.",
  });
export type RecordServiceUsageInput = z.infer<typeof recordServiceUsageSchema>;

export const reverseServiceUsageSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
export type ReverseServiceUsageInput = z.infer<typeof reverseServiceUsageSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const serviceVisitsQuerySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    filter: z.enum(["all", "missing", "recorded"]).default("all"),
  })
  .strict();
export type ServiceVisitsQuery = z.infer<typeof serviceVisitsQuerySchema>;

export const inventoryDashboardQuerySchema = z.object({ to: day.optional() }).strict();
export type InventoryDashboardQuery = z.infer<typeof inventoryDashboardQuerySchema>;

// ---------- DTOs ----------

export interface ServiceRecipeLineDto {
  id: string;
  inventoryCategoryId: string;
  categoryName: string;
  quantity: string;
  unit: InventoryUnit;
  defaultProductId: string | null;
  defaultProductName: string | null;
  autoDeduct: boolean;
}

export interface ServiceRecipeDto {
  serviceId: string;
  serviceName: string;
  serviceCategory: string | null;
  isActive: boolean;
  lines: ServiceRecipeLineDto[];
  /** Product category names suggested for this service that the salon has not added yet. */
  suggestions: string[];
}

/** A stocked product shown as a photo card when choosing what was used. */
export interface UsageProductOptionDto {
  productId: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  categoryId: string | null;
  stockOnHand: string;
  unit: InventoryUnit;
  contentSize: string | null;
  contentUnit: InventoryUnit | null;
  /** Used for this salon's services in the last 30 days, most recent first (0 = latest). */
  recentRank: number | null;
}

export interface UsageRecordDto {
  id: string;
  status: ServiceUsageStatus;
  source: ServiceUsageSource;
  recordedAt: string;
  /** The barber who served this visit, when known. */
  staffName: string | null;
  items: { productId: string; productName: string; quantity: string; unit: InventoryUnit; enteredQuantity: string; enteredUnit: InventoryUnit }[];
}

export interface VisitUsageServiceDto {
  serviceId: string;
  serviceName: string;
  lines: (ServiceRecipeLineDto & { productIds: string[] })[];
  recorded: UsageRecordDto | null;
}

/** Everything needed to pick the products used for one visit (one queue entry, 1+ services). */
export interface VisitUsageOptionsDto {
  queueEntryId: string;
  salonId: string;
  tokenNumber: number;
  customerName: string | null;
  status: string;
  services: VisitUsageServiceDto[];
  /** Every active product on the "used on services" shelf, for "something else was used". */
  products: UsageProductOptionDto[];
  /** True when the salon has recipes or products for these services — otherwise skip the picker. */
  hasAnythingToRecord: boolean;
}

export interface RecordServiceUsageResultDto {
  services: { serviceId: string; usage: UsageRecordDto; created: boolean }[];
}

export interface ServiceVisitDto {
  queueEntryId: string;
  tokenNumber: number;
  customerName: string | null;
  staffName: string | null;
  completedAt: string | null;
  services: { serviceId: string; serviceName: string; usage: UsageRecordDto | null; hasRecipe: boolean }[];
}

export interface ServiceVisitsDto {
  range: { from: string; to: string };
  items: ServiceVisitDto[];
  missingCount: number;
}

export interface InventoryDashboardDto {
  asOf: string;
  currency: string | null;
  totals: {
    activeProducts: number;
    lowStock: number;
    outOfStock: number;
    stockValue: string;
    expiringSoon: number;
  };
  /** Cost of stock used (at the average cost when used), per day for the last 30 days. */
  usageByDay: { day: string; value: string; entries: number }[];
  usage: { today: string; last7Days: string; last30Days: string };
  purchases30Days: { value: string; entries: number };
  wastage30Days: { value: string; entries: number };
  retailOut30Days: { value: string; entries: number };
  byService30Days: { serviceId: string; serviceName: string; visits: number; value: string }[];
  topProducts30Days: { productId: string; name: string; quantity: string; unit: InventoryUnit; value: string }[];
  expiring: { productId: string; name: string; batchNumber: string | null; expiryDate: string; stockOnHand: string; unit: InventoryUnit }[];
  /** Completed visits in the last 7 days with a recipe but no products recorded. */
  visitsMissingUsage7Days: number;
}

