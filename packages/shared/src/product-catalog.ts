import { z } from "zod";
import { InventoryUnit } from "./inventory";

// FastQue Global Product Master (Inventory Phase 1). One shared catalog of products identified by
// barcode; every salon keeps its own quantities, costs and selling prices in its InventoryProduct
// rows. Nothing here is invented: a product is VERIFIED only when an admin verified or imported it,
// and a salon's own submission stays PENDING (usable by that salon) until reviewed.

export const CATALOG_PATHS = {
  catalog: "catalog",
  images: "images",
  lookup: "lookup",
  products: "products",
  receive: "receive",
  transfer: "transfer",
  /** POST …/inventory/products/:productId/link-catalog — attach a barcode to a product the salon already has. */
  linkCatalog: "link-catalog",
  /** Admin routes, under admin/. */
  adminCatalog: "inventory-catalog",
  adminImportPreview: "import/preview",
  adminImportCommit: "import/commit",
  adminInventoryOverview: "inventory-overview",
} as const;

export const ProductType = {
  PROFESSIONAL: "PROFESSIONAL",
  RETAIL: "RETAIL",
  BOTH: "BOTH",
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const ProductDataSource = {
  ADMIN: "ADMIN",
  CSV_IMPORT: "CSV_IMPORT",
  OPEN_BEAUTY_FACTS: "OPEN_BEAUTY_FACTS",
  SALON_SUBMITTED: "SALON_SUBMITTED",
} as const;
export type ProductDataSource =
  (typeof ProductDataSource)[keyof typeof ProductDataSource];

export const ProductVerificationStatus = {
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
} as const;
export type ProductVerificationStatus =
  (typeof ProductVerificationStatus)[keyof typeof ProductVerificationStatus];

/** Which shelf a salon's stock sits on: used on customers' services, or sold to customers. */
export const StockUsage = {
  PROFESSIONAL: "PROFESSIONAL",
  RETAIL: "RETAIL",
} as const;
export type StockUsage = (typeof StockUsage)[keyof typeof StockUsage];

export const BarcodeFormat = {
  GTIN: "GTIN",
  OTHER: "OTHER",
} as const;
export type BarcodeFormat = (typeof BarcodeFormat)[keyof typeof BarcodeFormat];

export const CatalogErrorCode = {
  INVALID_BARCODE: "CATALOG_INVALID_BARCODE",
  BARCODE_EXISTS: "CATALOG_BARCODE_EXISTS",
  PRODUCT_NOT_FOUND: "CATALOG_PRODUCT_NOT_FOUND",
  NOT_USABLE: "CATALOG_PRODUCT_NOT_USABLE",
  IMPORT_INVALID: "CATALOG_IMPORT_INVALID",
  FORBIDDEN: "CATALOG_FORBIDDEN",
  ALREADY_LINKED: "CATALOG_PRODUCT_ALREADY_LINKED",
  LINK_CONFLICT: "CATALOG_LINK_CONFLICT",
} as const;

// ---------- Barcodes ----------

/** GS1 mod-10 check digit for the digits before it (works for GTIN-8/12/13/14). */
export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** Expands an 8-digit UPC-E (number system 0 or 1) to its 12-digit UPC-A. */
export function expandUpcE(upce: string): string | null {
  if (!/^[01]\d{7}$/.test(upce)) return null;
  const [ns, d1, d2, d3, d4, d5, d6, check] = upce.split("");
  let body: string;
  if (d6 === "0" || d6 === "1" || d6 === "2") body = `${ns}${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === "3") body = `${ns}${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === "4") body = `${ns}${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${ns}${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  return `${body}${check}`;
}

export type NormalizedBarcode =
  | { ok: true; code: string; format: BarcodeFormat; display: string }
  | { ok: false; reason: string };

/**
 * One canonical text form per barcode, so the same product matches however it is scanned or typed.
 * Retail barcodes (EAN-13, EAN-8, UPC-A, GTIN-14) must pass their check digit and are stored as a
 * 14-digit GTIN (leading zeros kept — never stored as a number), so UPC-A 012345678905 and
 * EAN-13 0012345678905 are the same product. A UPC-E is expanded first when the caller says the
 * scanner read UPC-E (an 8-digit code is otherwise treated as EAN-8). Other symbologies (Code 128,
 * etc.) are kept as uppercase text.
 */
export function normalizeBarcode(raw: string, hint?: "UPC_E"): NormalizedBarcode {
  const compact = raw.trim().replace(/[\s-]/g, "");
  if (!compact) return { ok: false, reason: "Enter or scan a barcode." };
  if (/^\d+$/.test(compact)) {
    let digits = compact;
    if (hint === "UPC_E") {
      const expanded = expandUpcE(digits);
      if (!expanded) return { ok: false, reason: "This UPC-E barcode is not valid." };
      digits = expanded;
    }
    if ([8, 12, 13, 14].includes(digits.length)) {
      const body = digits.slice(0, -1);
      if (gtinCheckDigit(body) !== Number(digits[digits.length - 1])) {
        return { ok: false, reason: "The barcode's check digit doesn't match. Scan again or check the number." };
      }
      return { ok: true, code: digits.padStart(14, "0"), format: BarcodeFormat.GTIN, display: digits };
    }
    if (digits.length > 48) return { ok: false, reason: "This barcode is too long." };
    return { ok: true, code: digits, format: BarcodeFormat.OTHER, display: digits };
  }
  if (!/^[\x21-\x7e]{1,48}$/.test(compact)) {
    return { ok: false, reason: "Barcodes can only contain letters, numbers and symbols (up to 48)." };
  }
  return { ok: true, code: compact.toUpperCase(), format: BarcodeFormat.OTHER, display: compact };
}

// ---------- Schemas ----------

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
const money = z.number().finite().nonnegative().max(9999999999.99).multipleOf(0.01);
const quantity = z.number().finite().positive().max(999999999.999).multipleOf(0.001);

const barcodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => normalizeBarcode(value).ok, (value) => ({
    message: (normalizeBarcode(value) as { reason?: string }).reason ?? "Invalid barcode",
  }));

export const catalogProductFieldsSchema = z.object({
  name: text(160),
  brand: optionalText(120),
  manufacturer: optionalText(160),
  category: optionalText(80),
  subcategory: optionalText(80),
  description: optionalText(1000),
  packSize: z.number().finite().positive().max(999999).multipleOf(0.001).optional().nullable(),
  packUnit: z.nativeEnum(InventoryUnit).optional().nullable(),
  mrp: money.optional().nullable(),
  hsnCode: z.string().trim().regex(/^\d{4,8}$/, "HSN codes have 4 to 8 digits").optional().nullable(),
  gstRatePercent: z.number().finite().min(0).max(28).multipleOf(0.01).optional().nullable(),
  productType: z.nativeEnum(ProductType).default(ProductType.BOTH),
});

/** A salon submitting a product its scan didn't find (stays PENDING until an admin verifies it). */
export const submitCatalogProductSchema = catalogProductFieldsSchema
  .extend({
    barcode: barcodeSchema,
    barcodeHint: z.enum(["UPC_E"]).optional(),
    dataSource: z.enum([ProductDataSource.SALON_SUBMITTED, ProductDataSource.OPEN_BEAUTY_FACTS]).default(ProductDataSource.SALON_SUBMITTED),
    sourceReference: optionalText(300),
    imageUrls: z.array(z.string().trim().url().max(500)).max(4).default([]),
  })
  .strict();
export type SubmitCatalogProductInput = z.infer<typeof submitCatalogProductSchema>;

export const catalogLookupQuerySchema = z
  .object({
    barcode: z.string().trim().min(1).max(64),
    hint: z.enum(["UPC_E"]).optional(),
  })
  .strict();
export type CatalogLookupQuery = z.infer<typeof catalogLookupQuerySchema>;

/**
 * Receive stock of a catalog product into this salon. Creates the salon's own inventory product
 * for that catalog product and shelf (professional or retail) the first time, then records the
 * incoming stock through the normal ledger (opening stock the first time, a purchase after that).
 */
export const receiveCatalogStockSchema = z
  .object({
    globalProductId: z.string().uuid(),
    /** Required when the catalog product's details aren't visible to this salon (awaiting review). */
    name: optionalText(120),
    usage: z.nativeEnum(StockUsage).default(StockUsage.PROFESSIONAL),
    unit: z.nativeEnum(InventoryUnit).optional(),
    quantity,
    unitCost: money,
    sellingPrice: money.optional().nullable(),
    supplierId: z.string().uuid().optional().nullable(),
    batchNumber: optionalText(60),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional().nullable(),
    storageLocation: optionalText(80),
    reorderThreshold: z.number().finite().nonnegative().max(999999999.999).multipleOf(0.001).optional(),
    reference: optionalText(120),
  })
  .strict();
export type ReceiveCatalogStockInput = z.infer<typeof receiveCatalogStockSchema>;

/** Move stock between the professional and retail shelves of the same catalog product. */
export const transferStockSchema = z
  .object({
    quantity,
    reason: optionalText(300),
  })
  .strict();
export type TransferStockInput = z.infer<typeof transferStockSchema>;

/** Attach a catalog product (its barcode) to one of the salon's existing products. */
export const linkCatalogProductSchema = z
  .object({
    globalProductId: z.string().uuid(),
  })
  .strict();
export type LinkCatalogProductInput = z.infer<typeof linkCatalogProductSchema>;

export const adminCatalogListQuerySchema = z
  .object({
    status: z.nativeEnum(ProductVerificationStatus).optional(),
    q: z.string().trim().max(120).optional(),
    cursor: z.string().trim().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type AdminCatalogListQuery = z.infer<typeof adminCatalogListQuerySchema>;

export const adminCatalogReviewSchema = z
  .object({
    action: z.enum(["VERIFY", "REJECT"]),
    note: optionalText(300),
    fields: catalogProductFieldsSchema.partial().optional(),
  })
  .strict()
  .refine((value) => value.action !== "REJECT" || !!value.note, { message: "Say why the product is rejected.", path: ["note"] });
export type AdminCatalogReviewInput = z.infer<typeof adminCatalogReviewSchema>;

export const CATALOG_IMPORT_MAX_ROWS = 5000;
export const CATALOG_IMPORT_MAX_BYTES = 2_000_000;
export const CATALOG_IMPORT_COLUMNS = [
  "barcode", "name", "brand", "manufacturer", "category", "subcategory", "description",
  "pack_size", "pack_unit", "mrp", "hsn_code", "gst_rate", "product_type", "image_url",
] as const;

/** Form fields sent with the uploaded CSV file (field "file", at most CATALOG_IMPORT_MAX_BYTES). */
export const adminCatalogImportSchema = z
  .object({
    /** Where the rows came from and under what licence — recorded on every imported product. */
    sourceReference: text(300),
    sourceLicense: text(80),
  })
  .strict();
export type AdminCatalogImportInput = z.infer<typeof adminCatalogImportSchema>;

export const adminInventoryOverviewQuerySchema = z
  .object({
    salonId: z.string().uuid().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
export type AdminInventoryOverviewQuery = z.infer<typeof adminInventoryOverviewQuerySchema>;

// ---------- CSV ----------

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = input.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  return rows;
}

export interface CatalogImportRowResult {
  line: number;
  barcode: string;
  name: string;
  status: "NEW" | "DUPLICATE_IN_FILE" | "EXISTS" | "INVALID";
  errors: string[];
  /** Normalized product for NEW rows (what will be saved on commit). */
  product?: z.infer<typeof catalogProductFieldsSchema> & { barcode: string; displayBarcode: string; imageUrl: string | null };
}

const UNIT_ALIASES: Record<string, InventoryUnit> = {
  each: "EACH", pc: "EACH", pcs: "EACH", piece: "EACH", unit: "EACH",
  g: "GRAM", gm: "GRAM", gram: "GRAM", grams: "GRAM",
  kg: "KILOGRAM", kilogram: "KILOGRAM",
  ml: "MILLILITER", milliliter: "MILLILITER", millilitre: "MILLILITER",
  l: "LITER", ltr: "LITER", liter: "LITER", litre: "LITER",
  pack: "PACK", box: "BOX",
};

/**
 * Validates every CSV row on its own (header row required, column names from
 * CATALOG_IMPORT_COLUMNS, any order). Existing barcodes are checked by the caller (`existing`).
 */
export function validateCatalogCsv(csv: string, existing: ReadonlySet<string>): { rows: CatalogImportRowResult[]; headerErrors: string[] } {
  const table = parseCsv(csv);
  if (table.length === 0) return { rows: [], headerErrors: ["The file is empty."] };
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const headerErrors: string[] = [];
  for (const required of ["barcode", "name"]) if (!header.includes(required)) headerErrors.push(`Missing the "${required}" column.`);
  const unknown = header.filter((h) => h && !(CATALOG_IMPORT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) headerErrors.push(`Unknown columns: ${unknown.join(", ")}.`);
  if (table.length - 1 > CATALOG_IMPORT_MAX_ROWS) headerErrors.push(`At most ${CATALOG_IMPORT_MAX_ROWS} rows per file.`);
  if (headerErrors.length) return { rows: [], headerErrors };

  const seen = new Map<string, number>();
  const rows = table.slice(1).map((cells, index): CatalogImportRowResult => {
    const line = index + 2;
    const get = (column: (typeof CATALOG_IMPORT_COLUMNS)[number]) => {
      const at = header.indexOf(column);
      const value = at === -1 ? "" : (cells[at] ?? "").trim();
      return value === "" ? null : value;
    };
    const errors: string[] = [];
    const rawBarcode = get("barcode") ?? "";
    const normalized = normalizeBarcode(rawBarcode);
    if (!normalized.ok) errors.push(normalized.reason);
    const num = (column: (typeof CATALOG_IMPORT_COLUMNS)[number], label: string) => {
      const value = get(column);
      if (value === null) return null;
      const parsed = Number(value.replace(/[₹,\s]/g, ""));
      if (!Number.isFinite(parsed)) {
        errors.push(`${label} must be a number.`);
        return null;
      }
      return parsed;
    };
    const unitText = get("pack_unit");
    const packUnit = unitText ? UNIT_ALIASES[unitText.toLowerCase()] ?? (unitText.toUpperCase() in InventoryUnit ? (unitText.toUpperCase() as InventoryUnit) : null) : null;
    if (unitText && !packUnit) errors.push(`Unknown pack unit "${unitText}".`);
    const typeText = get("product_type");
    const productType = typeText ? (typeText.toUpperCase() as ProductType) : ProductType.BOTH;
    if (typeText && !(productType in ProductType)) errors.push(`Product type must be professional, retail or both.`);
    const imageUrl = get("image_url");
    if (imageUrl && !/^https:\/\/\S{1,490}$/.test(imageUrl)) errors.push("Image URL must start with https://.");

    const candidate = {
      name: get("name") ?? "",
      brand: get("brand"),
      manufacturer: get("manufacturer"),
      category: get("category"),
      subcategory: get("subcategory"),
      description: get("description"),
      packSize: num("pack_size", "Pack size"),
      packUnit,
      mrp: num("mrp", "MRP"),
      hsnCode: get("hsn_code"),
      gstRatePercent: num("gst_rate", "GST rate"),
      productType,
    };
    const parsed = catalogProductFieldsSchema.safeParse(candidate);
    if (!parsed.success) for (const issue of parsed.error.issues) errors.push(`${issue.path.join(".") || "row"}: ${issue.message}`);

    const code = normalized.ok ? normalized.code : "";
    let status: CatalogImportRowResult["status"] = errors.length ? "INVALID" : "NEW";
    if (status === "NEW" && seen.has(code)) {
      status = "DUPLICATE_IN_FILE";
      errors.push(`Same barcode as line ${seen.get(code)}.`);
    } else if (status === "NEW" && existing.has(code)) {
      status = "EXISTS";
    }
    if (code && !seen.has(code)) seen.set(code, line);
    return {
      line,
      barcode: rawBarcode,
      name: candidate.name,
      status,
      errors,
      ...(status === "NEW" && parsed.success && normalized.ok
        ? { product: { ...parsed.data, barcode: normalized.code, displayBarcode: normalized.display, imageUrl } }
        : {}),
    };
  });
  return { rows, headerErrors };
}

// ---------- DTOs ----------

export interface CatalogProductDto {
  id: string;
  name: string;
  brand: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  description: string | null;
  packSize: string | null;
  packUnit: InventoryUnit | null;
  mrp: string | null;
  currency: string | null;
  hsnCode: string | null;
  gstRatePercent: string | null;
  productType: ProductType;
  dataSource: ProductDataSource;
  sourceReference: string | null;
  sourceLicense: string | null;
  verificationStatus: ProductVerificationStatus;
  barcodes: { code: string; display: string; format: BarcodeFormat }[];
  imageUrls: string[];
  createdAt: string;
  updatedAt: string;
}

/** Same as CatalogProductDto, plus who submitted it and review details (admin only). */
export interface AdminCatalogProductDto extends CatalogProductDto {
  submittedBySalon: { id: string; name: string } | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  salonsStocking: number;
  possibleDuplicates: { id: string; name: string; brand: string | null }[];
}

/** An outside product database's suggestion — never saved until the salon confirms it. */
export interface ExternalProductSuggestionDto {
  source: "OPEN_BEAUTY_FACTS";
  attribution: string;
  license: string;
  sourceUrl: string;
  name: string | null;
  brand: string | null;
  packSizeText: string | null;
  category: string | null;
  imageUrl: string | null;
}

export interface CatalogLookupResultDto {
  barcode: { code: string; display: string; format: BarcodeFormat };
  /**
   * FOUND: verified catalog product. FOUND_PENDING: this salon's own submission, awaiting review.
   * PENDING_ELSEWHERE: another salon submitted this barcode and it awaits review — its details are
   * not shown, but this salon can stock it under its own product name (pendingProductId).
   * EXTERNAL: not in the catalog; an outside database's suggestion. NOT_FOUND: nothing known.
   */
  status: "FOUND" | "FOUND_PENDING" | "PENDING_ELSEWHERE" | "EXTERNAL" | "NOT_FOUND";
  pendingProductId: string | null;
  product: CatalogProductDto | null;
  suggestion: ExternalProductSuggestionDto | null;
  /** This salon's own stock of the product, per shelf. */
  salonStock: { inventoryProductId: string; usage: StockUsage; stockOnHand: string; unit: InventoryUnit }[];
  /**
   * The salon's active products not linked to any barcode yet, so a scan can be attached to a
   * product added earlier by hand. `likelyMatch` marks one whose SKU looks like part of this barcode.
   */
  linkCandidates: CatalogLinkCandidateDto[];
}

export interface AdminInventoryOverviewDto {
  range: { from: string; to: string };
  salonId: string | null;
  kpis: {
    shopsUsingInventory: number;
    productsTracked: number;
    stockValue: string;
    lowStockItems: number;
    outOfStockItems: number;
    purchasesValue: string;
    purchaseEntries: number;
    consumptionEntries: number;
    lossEntries: number;
    catalogVerified: number;
    catalogPending: number;
  };
  shops: Array<{
    salonId: string;
    name: string;
    city: string | null;
    productsTracked: number;
    stockValue: string;
    lowStockItems: number;
    outOfStockItems: number;
    movementsInRange: number;
    lastStockUpdate: string | null;
  }>;
  topProducts: Array<{ globalProductId: string; name: string; brand: string | null; salons: number }>;
}

export interface CatalogLinkCandidateDto {
  inventoryProductId: string;
  name: string;
  sku: string | null;
  usage: StockUsage;
  stockOnHand: string;
  unit: InventoryUnit;
  likelyMatch: boolean;
}

/**
 * True when a salon product's SKU looks like this barcode or a piece of it — typically the big
 * printed digits typed without the small ones at each end (SKU 7874204037 vs UPC 078742040370).
 */
export function skuMatchesBarcode(sku: string | null | undefined, barcode: { code: string; display: string }): boolean {
  const digits = (sku ?? "").replace(/[\s-]/g, "");
  if (!digits) return false;
  if (digits.toUpperCase() === barcode.code || digits === barcode.display) return true;
  return /^\d{6,}$/.test(digits) && barcode.display.includes(digits);
}
