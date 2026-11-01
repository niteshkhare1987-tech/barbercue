import { z } from "zod";
import type { InventoryUnit } from "./inventory";

/**
 * Inventory Phase 3 — Smart Prediction. A transparent statistical forecast (no paid AI): a
 * weighted average of recent daily use, checked against what upcoming bookings will need, turned
 * into days of stock left, a stock-out date, a reorder-by date (supplier lead time + safety days)
 * and a suggested order quantity. With too little history it says so instead of guessing.
 * `forecastProduct` is a pure function so a smarter model can replace it behind the same output.
 */

export const FORECAST_PATHS = {
  predictions: "predictions",
  settings: "forecast-settings",
  alerts: "alerts",
  dismiss: "dismiss",
  runAlerts: "alerts/run",
  /** suppliers/:supplierId/lead-time */
  leadTime: "lead-time",
  analytics: "analytics",
} as const;

export const FORECAST_METHOD = "weighted-moving-average-v1";

/** Days of daily history the forecast looks at. */
export const FORECAST_HISTORY_DAYS = 56;
/** Days of upcoming bookings counted as known demand. */
export const FORECAST_BOOKING_DAYS = 14;

export type ForecastConfidence = "NOT_ENOUGH_DATA" | "LOW" | "MEDIUM" | "HIGH";
export type ForecastStatus = "OUT_OF_STOCK" | "ORDER_NOW" | "ORDER_SOON" | "OK" | "NO_DATA";
export type ForecastTrend = "UP" | "DOWN" | "STEADY" | "UNKNOWN";

export interface ForecastSettings {
  /** Days from ordering to the stock arriving (a supplier's own value wins). */
  leadTimeDays: number;
  /** Extra days of stock kept as a cushion. */
  safetyDays: number;
  /** Days of use one order should cover. */
  coverDays: number;
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = { leadTimeDays: 5, safetyDays: 3, coverDays: 14 };

export interface ForecastInput {
  /** Stock-unit quantity used per day, oldest first, ending yesterday (at most 56 days). */
  dailyUse: number[];
  /** Days since the product's first stock entry (its history may be shorter than dailyUse). */
  historyDays: number;
  stockOnHand: number;
  /** Quantity the next 14 days of booked services are expected to use (from recipes). */
  bookedDemand14Days: number;
  reorderThreshold: number;
  minimumOrderQuantity: number | null;
  settings: ForecastSettings;
  /** The shop's today, YYYY-MM-DD. */
  today: string;
}

export interface ForecastResult {
  method: typeof FORECAST_METHOD;
  status: ForecastStatus;
  confidence: ForecastConfidence;
  /** Expected use per day (stock units), or null when there is not enough data. */
  dailyRate: number | null;
  averageDaily14: number;
  averageDaily56: number;
  trend: ForecastTrend;
  daysLeft: number | null;
  stockOutDate: string | null;
  reorderDate: string | null;
  /** Stock level at which to reorder: use over lead time + safety days. */
  reorderPoint: number | null;
  suggestedOrderQuantity: number | null;
  /** Plain-language reason for the status. */
  explanation: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 864e5);
}

/** Rounds an order up to whole units and to a multiple of the minimum order quantity. */
export function roundOrderQuantity(quantity: number, moq: number | null): number {
  if (quantity <= 0) return 0;
  const whole = Math.ceil(quantity - 1e-9);
  if (!moq || moq <= 0) return whole;
  return Math.ceil(whole / moq - 1e-9) * moq;
}

export function forecastProduct(input: ForecastInput): ForecastResult {
  const { settings, today } = input;
  const window = Math.max(0, Math.min(input.dailyUse.length, input.historyDays, FORECAST_HISTORY_DAYS));
  const history = input.dailyUse.slice(input.dailyUse.length - window);
  const last14 = history.slice(-14);
  const prev14 = history.slice(-28, -14);
  const avg14 = mean(last14);
  const avg56 = mean(history);
  const usageDays = history.filter((x) => x > 0).length;
  const bookedRate = input.bookedDemand14Days / FORECAST_BOOKING_DAYS;

  let trend: ForecastTrend = "UNKNOWN";
  if (last14.length === 14 && prev14.length === 14) {
    const a = mean(prev14);
    const b = avg14;
    trend = a === 0 && b === 0 ? "STEADY" : a === 0 ? "UP" : b > a * 1.15 ? "UP" : b < a * 0.85 ? "DOWN" : "STEADY";
  }

  // Confidence grows with history length and how many days actually had use.
  let confidence: ForecastConfidence;
  if (window < 7 || usageDays < 3) confidence = "NOT_ENOUGH_DATA";
  else if (window < 21 || usageDays < 6) confidence = "LOW";
  else if (window < 42 || usageDays < 10) confidence = "MEDIUM";
  else confidence = "HIGH";

  // Recent use weighs more; known bookings set a floor.
  const historyRate = confidence === "NOT_ENOUGH_DATA" ? 0 : window >= 21 ? 0.6 * avg14 + 0.4 * avg56 : avg14;
  let rate = Math.max(historyRate, bookedRate);
  if (confidence === "NOT_ENOUGH_DATA" && bookedRate > 0) confidence = "LOW";
  if (!(rate > 0)) rate = 0;

  const stock = Math.max(0, input.stockOnHand);
  const base = {
    method: FORECAST_METHOD,
    confidence,
    averageDaily14: round3(avg14),
    averageDaily56: round3(avg56),
    trend,
  } as const;

  if (stock <= 0)
    return {
      ...base,
      status: "OUT_OF_STOCK",
      dailyRate: rate > 0 ? round3(rate) : null,
      daysLeft: 0,
      stockOutDate: today,
      reorderDate: today,
      reorderPoint: rate > 0 ? round3(rate * (settings.leadTimeDays + settings.safetyDays)) : null,
      suggestedOrderQuantity:
        rate > 0 ? roundOrderQuantity(rate * (settings.leadTimeDays + settings.coverDays + settings.safetyDays), input.minimumOrderQuantity) : null,
      explanation: "Out of stock.",
    };

  if (rate === 0) {
    const low = input.reorderThreshold > 0 && stock <= input.reorderThreshold;
    return {
      ...base,
      status: low ? "ORDER_NOW" : "NO_DATA",
      confidence: confidence === "NOT_ENOUGH_DATA" ? "NOT_ENOUGH_DATA" : confidence,
      dailyRate: null,
      daysLeft: null,
      stockOutDate: null,
      reorderDate: low ? today : null,
      reorderPoint: null,
      suggestedOrderQuantity: null,
      explanation: low
        ? "At or below your warning level. Not enough use recorded yet to predict when it runs out."
        : confidence === "NOT_ENOUGH_DATA"
          ? "Not enough data: record use for at least a week to get a prediction."
          : "No use recorded recently.",
    };
  }

  const daysLeft = stock / rate;
  const reorderPoint = rate * (settings.leadTimeDays + settings.safetyDays);
  const daysToReorder = Math.max(0, Math.floor((stock - reorderPoint) / rate));
  const reorderDate = addDays(today, daysToReorder);
  const stockOutDate = addDays(today, Math.floor(daysLeft));
  // Enough for the lead time, the cover period and the safety cushion, minus what is on hand.
  const needed = rate * (settings.leadTimeDays + settings.coverDays + settings.safetyDays) - stock;
  const atWarning = input.reorderThreshold > 0 && stock <= input.reorderThreshold;
  const status: ForecastStatus = daysToReorder <= 0 || atWarning ? "ORDER_NOW" : daysToReorder <= 7 ? "ORDER_SOON" : "OK";
  const booked = bookedRate > historyRate ? " Upcoming bookings need more than recent use." : "";
  return {
    ...base,
    status,
    dailyRate: round3(rate),
    daysLeft: Math.round(daysLeft * 10) / 10,
    stockOutDate,
    reorderDate,
    reorderPoint: round3(reorderPoint),
    suggestedOrderQuantity: status === "OK" && needed <= 0 ? null : roundOrderQuantity(Math.max(needed, 0), input.minimumOrderQuantity) || null,
    explanation:
      (status === "ORDER_NOW"
        ? `Order now: about ${Math.floor(daysLeft)} days left and delivery takes ${settings.leadTimeDays} days.`
        : status === "ORDER_SOON"
          ? `Order by ${reorderDate} to keep ${settings.safetyDays} days of cushion.`
          : `About ${Math.floor(daysLeft)} days of stock left.`) + booked,
  };
}

// ---------- Batches and expiry (oldest stock is used first) ----------

export interface Receipt {
  quantity: number;
  batchNumber: string | null;
  expiryDate: string | null;
  /** When it was received (ISO). */
  receivedAt: string;
}

export interface EstimatedBatch {
  batchNumber: string | null;
  expiryDate: string | null;
  receivedAt: string;
  /** Estimated quantity of this receipt still on hand. */
  remaining: number;
}

/**
 * Which receipts the stock on hand most likely comes from, assuming older stock is used first:
 * the newest receipts are the ones still on the shelf. Stock is tracked per product, so this is an
 * estimate — shown as such.
 */
export function estimateBatches(stockOnHand: number, receipts: Receipt[]): EstimatedBatch[] {
  let left = Math.max(0, stockOnHand);
  const out: EstimatedBatch[] = [];
  for (const r of [...receipts].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, r.quantity));
    if (take <= 0) continue;
    out.push({ batchNumber: r.batchNumber, expiryDate: r.expiryDate, receivedAt: r.receivedAt, remaining: round3(take) });
    left = round3(left - take);
  }
  return out.reverse();
}

export interface ExpiryRisk extends EstimatedBatch {
  daysToExpiry: number;
  /** Estimated quantity of this batch that won't be used before it expires. */
  atRisk: number;
}

/** Batches expiring within `horizonDays` (or already expired), and how much may go unused. */
export function expiryRisks(batches: EstimatedBatch[], dailyRate: number | null, today: string, horizonDays = 30): ExpiryRisk[] {
  const risks: ExpiryRisk[] = [];
  let usedBefore = 0; // stock in older batches, used first
  for (const b of batches) {
    if (b.expiryDate) {
      const days = daysBetween(today, b.expiryDate);
      if (days <= horizonDays) {
        const usable = dailyRate && dailyRate > 0 ? Math.max(0, dailyRate * Math.max(0, days) - usedBefore) : 0;
        risks.push({ ...b, daysToExpiry: days, atRisk: round3(days <= 0 ? b.remaining : Math.max(0, b.remaining - usable)) });
      }
    }
    usedBefore += b.remaining;
  }
  return risks;
}

// ---------- Settings, DTOs ----------

export const forecastSettingsSchema = z
  .object({
    leadTimeDays: z.number().int().min(0).max(90),
    safetyDays: z.number().int().min(0).max(60),
    coverDays: z.number().int().min(1).max(120),
    alertsEnabled: z.boolean(),
  })
  .strict();
export type ForecastSettingsInput = z.infer<typeof forecastSettingsSchema>;

export const supplierLeadTimeSchema = z.object({ leadTimeDays: z.number().int().min(0).max(90).nullable() }).strict();
export type SupplierLeadTimeInput = z.infer<typeof supplierLeadTimeSchema>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
/** Either explicit dates, or `days` back from the shop's own today (the server knows the shop's time zone). */
export const inventoryAnalyticsQuerySchema = z
  .object({ from: day.optional(), to: day.optional(), days: z.coerce.number().int().min(1).max(366).optional() })
  .strict();
export type InventoryAnalyticsQuery = z.infer<typeof inventoryAnalyticsQuerySchema>;

export interface ProductPredictionDto extends Omit<ForecastResult, "method"> {
  productId: string;
  name: string;
  categoryName: string | null;
  supplierName: string | null;
  unit: InventoryUnit;
  stockOnHand: string;
  leadTimeDays: number;
  bookedDemand14Days: number;
  expiry: ExpiryRisk[];
}

export interface InventoryAlertDto {
  id: string;
  kind: "REORDER" | "STOCK_OUT" | "EXPIRING" | "EXPIRED";
  productId: string | null;
  title: string;
  detail: string;
  createdAt: string;
}

export interface InventoryPredictionsDto {
  asOf: string;
  method: typeof FORECAST_METHOD;
  settings: ForecastSettingsInput;
  suppliers: { id: string; name: string; leadTimeDays: number | null }[];
  summary: { orderNow: number; orderSoon: number; outOfStock: number; notEnoughData: number; expiringAtRisk: number };
  products: ProductPredictionDto[];
  alerts: InventoryAlertDto[];
}

export interface InventoryAnalyticsRowDto {
  productId: string;
  name: string;
  categoryName: string | null;
  unit: InventoryUnit;
  receivedQuantity: string;
  receivedValue: string;
  usedQuantity: string;
  usedValue: string;
  lostQuantity: string;
  lostValue: string;
  stockOnHand: string;
  stockValue: string;
}

export interface InventoryAnalyticsDto {
  range: { from: string; to: string };
  currency: string | null;
  totals: { receivedValue: string; usedValue: string; lostValue: string; stockValue: string };
  byWeek: { weekStart: string; usedValue: string; receivedValue: string; lostValue: string }[];
  byCategory: { categoryName: string; usedValue: string; receivedValue: string }[];
  products: InventoryAnalyticsRowDto[];
}

/** CSV for the analytics table (spreadsheet-safe: formula-like cells are prefixed). */
export function analyticsCsv(data: InventoryAnalyticsDto): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const head = ["Product", "Category", "Unit", "Received qty", "Received value", "Used qty", "Used value", "Lost qty", "Lost value", "Stock now", "Stock value"];
  const rows = data.products.map((p) => [p.name, p.categoryName ?? "", p.unit, p.receivedQuantity, p.receivedValue, p.usedQuantity, p.usedValue, p.lostQuantity, p.lostValue, p.stockOnHand, p.stockValue]);
  return [head, ...rows].map((r) => r.map((v) => cell(String(v))).join(",")).join("\r\n") + "\r\n";
}
