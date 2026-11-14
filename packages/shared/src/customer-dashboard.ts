import { z } from "zod";
import type { SalonListItemDto } from "./types";

// Customer dashboard (docs/customer-dashboard/PROGRESS.md). Additive API surface only — every
// existing endpoint keeps its behaviour when these optional parameters are absent.

export const RECENTLY_VIEWED_PATHS = {
  recentlyViewed: "recently-viewed",
} as const;

/** Default cap on stored recently-viewed salons per customer (server env RECENTLY_VIEWED_LIMIT overrides). */
export const RECENTLY_VIEWED_DEFAULT_LIMIT = 20;

/** GET recently-viewed — the customer's own history, most recent first, active salons only. */
export interface RecentSalonDto extends SalonListItemDto {
  viewedAt: string; // ISO 8601
}

/** GET reviews/mine — a customer's own reviews with the visit they belong to. */
export interface CustomerReviewDto {
  id: string;
  bookingId: string;
  salonId: string;
  salonName: string;
  salonSlug: string;
  citySlug: string;
  countryCode: string;
  serviceName: string;
  visitDate: string; // booking slotStart, ISO 8601
  rating: number;
  comment: string | null;
  ownerResponse: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CUSTOMER_BOOKING_STATUS_FILTERS = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "EXPIRED",
] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Must be a real YYYY-MM-DD date");

const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

/**
 * GET bookings/mine optional filters. `from`/`to` are inclusive calendar days (UTC bounds, widened
 * by a day on each side is NOT done — the client sends exactly what the customer picked).
 */
export const customerBookingListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    status: csvOf(CUSTOMER_BOOKING_STATUS_FILTERS).optional(),
    salonId: z.string().uuid().optional(),
    sort: z.enum(["newest", "oldest"]).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to.", path: ["from"] });
export type CustomerBookingListQuery = z.infer<typeof customerBookingListQuerySchema>;

export const CUSTOMER_INVOICE_PAYMENT_FILTERS = ["UNPAID", "PARTIALLY_PAID", "PAID", "REFUNDED"] as const;

/** GET invoices/mine optional filters. */
export const customerInvoiceListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    paymentStatus: z.enum(CUSTOMER_INVOICE_PAYMENT_FILTERS).optional(),
    salonId: z.string().uuid().optional(),
    q: z.string().trim().min(1).max(60).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to.", path: ["from"] });
export type CustomerInvoiceListQuery = z.infer<typeof customerInvoiceListQuerySchema>;

/** Inclusive calendar-day range → [start, endExclusive) instants (UTC day bounds). */
export function dayRangeBounds(from?: string, to?: string): { gte?: Date; lt?: Date } {
  const out: { gte?: Date; lt?: Date } = {};
  if (from) out.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) {
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    out.lt = end;
  }
  return out;
}

export type DateRangePreset = "today" | "7d" | "30d" | "3m" | "12m";

export const DATE_RANGE_PRESETS: ReadonlyArray<{ id: DateRangePreset; label: string }> = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "3m", label: "Last 3 months" },
  { id: "12m", label: "Last 12 months" },
];

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A preset → inclusive local calendar days {from, to}, ending today. */
export function presetRange(preset: DateRangePreset, now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "7d") start.setDate(start.getDate() - 6);
  else if (preset === "30d") start.setDate(start.getDate() - 29);
  else if (preset === "3m") start.setMonth(start.getMonth() - 3);
  else if (preset === "12m") start.setFullYear(start.getFullYear() - 1);
  return { from: ymd(start), to: ymd(now) };
}

/** "Good morning/afternoon/evening" for the viewer's own local hour. */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Straight-line (great-circle) distance in km. Label it as straight-line wherever it is shown. */
export function straightLineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
