import { InventoryErrorCode, InventoryMovementKind, InventoryUnit } from "@barbercue/shared";
import type {
  CreateInventoryMovementInput,
  CreateInventoryProductInput,
  CreateInventorySupplierInput,
  InventoryMovementDto,
  InventoryProductDto,
  UpdateInventoryProductInput,
} from "@barbercue/shared";

// Owner inventory (requirement #8), on Codex PR #249. The server keeps a stock LEDGER: stock changes only through
// opening, purchase, consumption or reasoned adjustment movements, every balance and cost is computed by the server,
// and a movement can never be edited or deleted. This file only checks what an owner typed before it is sent and words
// what the server answers. It never adds up, subtracts or averages stock or money: balances, costs, valuation and the
// low-stock flag always come from the server, and a number on screen is a server string shown as-is (trailing zeros
// trimmed). "Estimated stock value" is what the stock on hand cost, not revenue and not money collected.

export type MovementKind = (typeof InventoryMovementKind)[keyof typeof InventoryMovementKind];
export type Unit = (typeof InventoryUnit)[keyof typeof InventoryUnit];

export const UNIT_OPTIONS: ReadonlyArray<{ value: Unit; label: string }> = [
  { value: "EACH", label: "Each (pieces)" },
  { value: "GRAM", label: "Grams (g)" },
  { value: "KILOGRAM", label: "Kilograms (kg)" },
  { value: "MILLILITER", label: "Millilitres (ml)" },
  { value: "LITER", label: "Litres (L)" },
  { value: "PACK", label: "Packs" },
  { value: "BOX", label: "Boxes" },
  { value: "OTHER", label: "Other" },
];

const UNIT_SHORT: Record<string, string> = { EACH: "pcs", GRAM: "g", KILOGRAM: "kg", MILLILITER: "ml", LITER: "L", PACK: "packs", BOX: "boxes", OTHER: "units" };

export function unitShort(unit: string): string {
  return UNIT_SHORT[unit] ?? unit;
}

export function isUnit(value: string): value is Unit {
  return UNIT_OPTIONS.some((u) => u.value === value);
}

export const KIND_LABEL: Record<string, string> = {
  OPENING: "Opening stock",
  PURCHASE: "Purchase",
  CONSUMPTION: "Used",
  ADJUSTMENT: "Adjustment",
  RETURN: "Returned to supplier",
  DAMAGE: "Damaged",
  EXPIRY: "Expired",
  WASTAGE: "Wasted",
  TRANSFER_OUT: "Moved to other shelf",
  TRANSFER_IN: "Moved from other shelf",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

export const MOVEMENT_KINDS: ReadonlyArray<MovementKind> = [
  "OPENING", "PURCHASE", "CONSUMPTION", "ADJUSTMENT", "RETURN", "DAMAGE", "EXPIRY", "WASTAGE", "TRANSFER_OUT", "TRANSFER_IN",
];

// ---------- showing server numbers ----------

/** A server decimal string such as "12.500" without trailing zeros ("12.5", "12"). Anything else is shown unchanged. */
export function trimDecimal(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

/** A server quantity with its unit: "12.5 kg". */
export function quantityText(value: string, unit: string): string {
  return `${trimDecimal(value)} ${unitShort(unit)}`;
}

/** A signed movement quantity, "+3" or "-2.5", exactly as the server recorded it. */
export function signedQuantity(value: string): string {
  const t = trimDecimal(value);
  return t.startsWith("-") || t.startsWith("+") ? t : `+${t}`;
}

/** Money from a server decimal string in the shop's own currency; "—" when the server sent nothing readable. */
export function moneyText(value: string | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return "—";
  const [whole, frac = ""] = value.split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = Number(digits) > 0 || digits === "0" ? Number(digits).toLocaleString("en-IN") : digits;
  const cents = frac.padEnd(2, "0").slice(0, 2);
  const body = cents === "00" ? grouped : `${grouped}.${cents}`;
  const sign = negative ? "-" : "";
  // No symbol is invented when the shop's currency is not known.
  if (!currency) return `${sign}${body}`;
  return currency === "INR" ? `${sign}₹${body}` : `${sign}${currency} ${body}`;
}

// ---------- reading what the owner typed ----------

const DECIMAL_RE = /^\d+(?:\.\d+)?$/;

function decimals(text: string): number {
  const i = text.indexOf(".");
  return i < 0 ? 0 : text.length - i - 1;
}

export const MAX_QUANTITY = 999999999.999;
export const MAX_MONEY = 9999999999.99;

/** A positive quantity with at most three decimals, or an explanation. */
export function parseQuantity(text: string): { value: number } | { error: string } {
  const t = text.trim().replace(",", ".");
  if (!t) return { error: "Enter a quantity." };
  if (!DECIMAL_RE.test(t)) return { error: "Enter a number, for example 2 or 1.5." };
  if (decimals(t) > 3) return { error: "Use at most 3 decimal places." };
  const value = Number(t);
  if (!(value > 0)) return { error: "The quantity must be more than zero." };
  if (value > MAX_QUANTITY) return { error: "That quantity is too large." };
  return { value };
}

/** A threshold or quantity that may be zero. */
export function parseThreshold(text: string): { value: number } | { error: string } {
  const t = text.trim().replace(",", ".");
  if (!t) return { value: 0 };
  if (!DECIMAL_RE.test(t)) return { error: "Enter a number, for example 5 or 2.5." };
  if (decimals(t) > 3) return { error: "Use at most 3 decimal places." };
  const value = Number(t);
  if (value > MAX_QUANTITY) return { error: "That number is too large." };
  return { value };
}

/** A cost per unit: zero or more, at most two decimals. */
export function parseMoney(text: string): { value: number } | { error: string } {
  const t = text.trim().replace(",", ".");
  if (!t) return { error: "Enter the cost per unit." };
  if (!DECIMAL_RE.test(t)) return { error: "Enter an amount, for example 120 or 99.50." };
  if (decimals(t) > 2) return { error: "Use at most 2 decimal places." };
  const value = Number(t);
  if (value > MAX_MONEY) return { error: "That amount is too large." };
  return { value };
}

type Result<T> = { value: T } | { error: string };

function errorOf(r: { error: string } | { value: unknown }): string | undefined {
  return "error" in r ? r.error : undefined;
}

// ---------- movement form ----------

export interface MovementForm {
  quantity: string;
  unitCost: string;
  supplierId: string;
  direction: "" | "INCREASE" | "DECREASE";
  reason: string;
  reference: string;
}

export const EMPTY_MOVEMENT: MovementForm = { quantity: "", unitCost: "", supplierId: "", direction: "", reason: "", reference: "" };

export type MovementErrors = Partial<Record<keyof MovementForm, string>>;

/** The same rules the server applies to a movement, checked before sending. The server stays the final authority. */
export function buildMovement(kind: MovementKind, form: MovementForm): { body: CreateInventoryMovementInput | null; errors: MovementErrors } {
  const errors: MovementErrors = {};
  const quantity = parseQuantity(form.quantity);
  const q = errorOf(quantity);
  if (q) errors.quantity = q;

  const incoming = kind === "OPENING" || kind === "PURCHASE";
  let unitCost: number | undefined;
  if (incoming) {
    const cost = parseMoney(form.unitCost);
    const c = errorOf(cost);
    if (c) errors.unitCost = c;
    else unitCost = (cost as { value: number }).value;
  }
  if (kind === "ADJUSTMENT") {
    if (form.direction !== "INCREASE" && form.direction !== "DECREASE") errors.direction = "Choose whether stock goes up or down.";
    if (!form.reason.trim()) errors.reason = "Say why you are adjusting stock.";
  }
  if (form.reason.trim().length > 300) errors.reason = "Use at most 300 characters.";
  if (form.reference.trim().length > 120) errors.reference = "Use at most 120 characters.";
  if (Object.keys(errors).length > 0) return { body: null, errors };

  const body: CreateInventoryMovementInput = { kind, quantity: (quantity as { value: number }).value };
  if (unitCost !== undefined) body.unitCost = unitCost;
  if (kind === "PURCHASE" && form.supplierId) body.supplierId = form.supplierId;
  if (kind === "ADJUSTMENT") body.adjustmentDirection = form.direction as "INCREASE" | "DECREASE";
  if (form.reason.trim()) body.reason = form.reason.trim();
  if (form.reference.trim()) body.reference = form.reference.trim();
  return { body, errors };
}

/** One key per attempt. The same attempt retried keeps its key so the server can replay it; a changed form gets a new one. */
export function newMovementKey(random: () => string = () => crypto.randomUUID()): string {
  return `inv-${random()}`;
}

/** A plain sentence for the confirmation step. It restates what was typed; it never predicts the resulting balance. */
export function movementSummary(kind: MovementKind, product: Pick<InventoryProductDto, "name" | "unit">, body: CreateInventoryMovementInput): string {
  const qty = `${trimDecimal(String(body.quantity))} ${unitShort(product.unit)}`;
  switch (kind) {
    case "OPENING":
      return `Record ${qty} of ${product.name} as your opening stock, at ${body.unitCost} per ${unitShort(product.unit)}. Opening stock can be recorded once per product.`;
    case "PURCHASE":
      return `Add ${qty} of ${product.name} bought at ${body.unitCost} per ${unitShort(product.unit)}.`;
    case "CONSUMPTION":
      return `Take ${qty} of ${product.name} out of stock as used.`;
    case "ADJUSTMENT":
      return `${body.adjustmentDirection === "DECREASE" ? "Reduce" : "Increase"} ${product.name} by ${qty}. Reason: ${body.reason}.`;
    default:
      // Write-offs (returned, damaged, expired, wasted) and shelf moves.
      return `Record ${qty} of ${product.name} as ${(KIND_LABEL[kind] ?? kind).toLowerCase()}.`;
  }
}

/** The server's words for a refusal, made plain. Anything unknown keeps the server's own message. */
export function movementErrorText(code: string | undefined, message: string): string {
  switch (code) {
    case InventoryErrorCode.INSUFFICIENT_STOCK:
      return "There is not enough stock for this. Nothing was recorded.";
    case InventoryErrorCode.OPENING_ALREADY_RECORDED:
      return "Opening stock was already recorded for this product. Use a purchase or an adjustment instead.";
    case InventoryErrorCode.IDEMPOTENCY_KEY_REUSED:
      return "This attempt was already used for a different entry. Review the form and submit again.";
    case InventoryErrorCode.PRODUCT_NOT_FOUND:
      return "This product no longer exists. Reload the page.";
    case InventoryErrorCode.SUPPLIER_NOT_FOUND:
      return "That supplier no longer exists. Pick another or leave it empty.";
    default:
      return message;
  }
}

// ---------- product / supplier / category forms ----------

export interface ProductForm {
  name: string;
  sku: string;
  unit: string;
  categoryId: string;
  supplierId: string;
  reorderThreshold: string;
  isActive: boolean;
}

export const EMPTY_PRODUCT: ProductForm = { name: "", sku: "", unit: "EACH", categoryId: "", supplierId: "", reorderThreshold: "", isActive: true };

export type ProductErrors = Partial<Record<keyof ProductForm, string>>;

export function productFormFrom(p: InventoryProductDto): ProductForm {
  return {
    name: p.name,
    sku: p.sku ?? "",
    unit: p.unit,
    categoryId: p.category?.id ?? "",
    supplierId: p.supplier?.id ?? "",
    reorderThreshold: trimDecimal(p.reorderThreshold),
    isActive: p.isActive,
  };
}

function validateProductCommon(form: ProductForm): { errors: ProductErrors; threshold: number } {
  const errors: ProductErrors = {};
  if (!form.name.trim()) errors.name = "Enter the product name.";
  else if (form.name.trim().length > 120) errors.name = "Use at most 120 characters.";
  if (form.sku.trim().length > 80) errors.sku = "Use at most 80 characters.";
  const t = parseThreshold(form.reorderThreshold);
  const e = errorOf(t);
  if (e) errors.reorderThreshold = e;
  return { errors, threshold: e ? 0 : (t as { value: number }).value };
}

export function buildCreateProduct(form: ProductForm): { body: CreateInventoryProductInput | null; errors: ProductErrors } {
  const { errors, threshold } = validateProductCommon(form);
  if (!isUnit(form.unit)) errors.unit = "Choose a unit.";
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const body: CreateInventoryProductInput = { name: form.name.trim(), unit: form.unit as Unit, reorderThreshold: threshold, isActive: form.isActive };
  if (form.sku.trim()) body.sku = form.sku.trim();
  if (form.categoryId) body.categoryId = form.categoryId;
  if (form.supplierId) body.supplierId = form.supplierId;
  return { body, errors };
}

/** Only what changed, so an edit never rewrites fields the owner did not touch. The unit is fixed once a product exists. */
export function buildProductPatch(original: InventoryProductDto, form: ProductForm): { body: UpdateInventoryProductInput | null; errors: ProductErrors; changed: boolean } {
  const { errors, threshold } = validateProductCommon(form);
  if (Object.keys(errors).length > 0) return { body: null, errors, changed: false };
  const body: UpdateInventoryProductInput = {};
  if (form.name.trim() !== original.name) body.name = form.name.trim();
  if ((form.sku.trim() || null) !== original.sku) body.sku = form.sku.trim() || null;
  if ((form.categoryId || null) !== (original.category?.id ?? null)) body.categoryId = form.categoryId || null;
  if ((form.supplierId || null) !== (original.supplier?.id ?? null)) body.supplierId = form.supplierId || null;
  if (threshold !== Number(original.reorderThreshold)) body.reorderThreshold = threshold;
  if (form.isActive !== original.isActive) body.isActive = form.isActive;
  return { body: Object.keys(body).length > 0 ? body : null, errors, changed: Object.keys(body).length > 0 };
}

export interface SupplierForm {
  name: string;
  contactName: string;
  phone: string;
  email: string;
  notes: string;
}

export const EMPTY_SUPPLIER: SupplierForm = { name: "", contactName: "", phone: "", email: "", notes: "" };

export type SupplierErrors = Partial<Record<keyof SupplierForm, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildSupplier(form: SupplierForm): { body: CreateInventorySupplierInput | null; errors: SupplierErrors } {
  const errors: SupplierErrors = {};
  if (!form.name.trim()) errors.name = "Enter the supplier's name.";
  else if (form.name.trim().length > 120) errors.name = "Use at most 120 characters.";
  if (form.contactName.trim().length > 120) errors.contactName = "Use at most 120 characters.";
  if (form.phone.trim().length > 40) errors.phone = "Use at most 40 characters.";
  if (form.email.trim() && (!EMAIL_RE.test(form.email.trim()) || form.email.trim().length > 254)) errors.email = "Enter a valid email address.";
  if (form.notes.trim().length > 500) errors.notes = "Use at most 500 characters.";
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const body: CreateInventorySupplierInput = { name: form.name.trim() };
  if (form.contactName.trim()) body.contactName = form.contactName.trim();
  if (form.phone.trim()) body.phone = form.phone.trim();
  if (form.email.trim()) body.email = form.email.trim();
  if (form.notes.trim()) body.notes = form.notes.trim();
  return { body, errors };
}

export function validateCategoryName(name: string): string | null {
  if (!name.trim()) return "Enter a category name.";
  if (name.trim().length > 80) return "Use at most 80 characters.";
  return null;
}

/** Plain words for the create/update refusals the server can send. */
export function entityErrorText(code: string | undefined, message: string): string {
  switch (code) {
    case InventoryErrorCode.CATEGORY_EXISTS:
      return "You already have a category with this name.";
    case InventoryErrorCode.SUPPLIER_EXISTS:
      return "You already have a supplier with this name.";
    case InventoryErrorCode.PRODUCT_EXISTS:
      return "You already have a product with this name or SKU.";
    case InventoryErrorCode.CATEGORY_NOT_FOUND:
      return "That category no longer exists. Reload the page.";
    case InventoryErrorCode.SUPPLIER_NOT_FOUND:
      return "That supplier no longer exists. Reload the page.";
    case InventoryErrorCode.CURSOR_FILTER_MISMATCH:
      return "The list changed while you were paging. It was reloaded from the start.";
    default:
      return message;
  }
}

// ---------- list queries ----------

export const PAGE_SIZE = 25;

export function listQuery(params: Record<string, string | boolean | null | undefined>, cursor: string | null, limit = PAGE_SIZE): string {
  const q = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    q.set(key, String(value));
  }
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

/** Search text for the server's `q` (at most 120 characters); under two characters is not searched. */
export function searchTerm(input: string): string {
  const t = input.trim();
  return t.length < 2 ? "" : t.slice(0, 120);
}

export function movementTone(kind: string, delta: string): "ok" | "warn" | "neutral" {
  if (kind === "CONSUMPTION") return "warn";
  if (delta.startsWith("-")) return "warn";
  return kind === "OPENING" || kind === "PURCHASE" || delta.startsWith("+") ? "ok" : "neutral";
}

export type { InventoryMovementDto };
