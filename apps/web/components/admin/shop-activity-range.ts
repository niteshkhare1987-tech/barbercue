import { ADMIN_SHOP_ACTIVITY_MAX_DAYS } from "@barbercue/shared";

// The admin date filter speaks India time, matching the backend's admin/shop-activity report.
export const SHOP_ACTIVITY_TIME_ZONE = "Asia/Kolkata";

export type ShopActivityPreset = "today" | "yesterday" | "last7" | "last30" | "custom";

export const SHOP_ACTIVITY_PRESETS: ReadonlyArray<{ id: Exclude<ShopActivityPreset, "custom">; label: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
];

/** Today's IST calendar date as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_ACTIVITY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Inclusive [from, to] IST dates for a quick pick; "last 7 days" includes today. */
export function presetRange(
  preset: Exclude<ShopActivityPreset, "custom">,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = istToday(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const yesterday = addDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
  }
}

/** Mirrors the server's validation so a bad custom range is explained before any request. */
export function rangeError(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return "Choose both a start and an end date.";
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1) return "The end date must be on or after the start date.";
  if (days > ADMIN_SHOP_ACTIVITY_MAX_DAYS) return `Choose a range of ${ADMIN_SHOP_ACTIVITY_MAX_DAYS} days or fewer.`;
  return null;
}

export function formatRangeLabel(from: string, to: string): string {
  const format = (date: string) =>
    new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${date}T00:00:00Z`),
    );
  return from === to ? format(from) : `${format(from)} – ${format(to)}`;
}
