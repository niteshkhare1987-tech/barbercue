import type { AdminAdoptionCategory, AdminExecutiveOverviewDto, AdminKpiValue } from "@barbercue/shared";

export const ADOPTION_LABELS: Record<AdminAdoptionCategory, string> = {
  HIGHLY_ACTIVE: "Highly active",
  MODERATELY_ACTIVE: "Moderately active",
  LOW_USAGE: "Low usage",
  AT_RISK: "At risk",
  DORMANT: "Dormant",
  NEVER_ACTIVATED: "Never activated",
  RECENTLY_ONBOARDED: "Recently onboarded",
};

// Display order: healthiest first, then the groups that need attention.
export const ADOPTION_ORDER: readonly AdminAdoptionCategory[] = [
  "HIGHLY_ACTIVE",
  "MODERATELY_ACTIVE",
  "LOW_USAGE",
  "AT_RISK",
  "DORMANT",
  "NEVER_ACTIVATED",
  "RECENTLY_ONBOARDED",
];

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export const formatInr = (paise: number) => inr.format(Math.round(paise / 100));
export const formatCount = (value: number) => count.format(value);
export const formatPercent = (value: number) => `${value.toFixed(1)}%`;
export const formatHours = (minutes: number) =>
  `${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(minutes / 60)} h`;

export type KpiKind = "count" | "money" | "percent" | "minutes";

export function formatKpi(value: number | null, kind: KpiKind): string {
  if (value === null) return "—";
  if (kind === "money") return formatInr(value);
  if (kind === "percent") return formatPercent(value);
  if (kind === "minutes") return formatHours(value);
  return formatCount(value);
}

/**
 * Change vs the previous period, written out (never color alone). Rates change in percentage
 * points; other values show the absolute change plus the percentage when the base is non-zero.
 */
export function describeChange(value: AdminKpiValue, kind: KpiKind): { text: string; direction: "up" | "down" | "flat" | "none" } {
  const { current, previous } = value;
  if (current === null || previous === null) return { text: "No comparison", direction: "none" };
  const diff = current - previous;
  if (diff === 0) return { text: "No change", direction: "flat" };
  const direction = diff > 0 ? "up" : "down";
  const sign = diff > 0 ? "+" : "−";
  if (kind === "percent") return { text: `${sign}${Math.abs(diff).toFixed(1)} pts`, direction };
  const absolute = kind === "money" ? formatInr(Math.abs(diff)) : kind === "minutes" ? formatHours(Math.abs(diff)) : formatCount(Math.abs(diff));
  const pct = previous !== 0 ? ` (${sign}${Math.abs((diff / previous) * 100).toFixed(0)}%)` : "";
  return { text: `${sign}${absolute}${pct}`, direction };
}

/** Neutralises spreadsheet formula injection (=, +, -, @, tab, CR) and quotes every cell. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function shopsCsv(data: AdminExecutiveOverviewDto): string {
  const header = [
    "Salon ID", "Salon", "City", "Status", "Adoption", "Completed visits", "Completed appointments",
    "Walk-ins served", "Cancelled", "No-show", "Service value (INR)", "Registered (UTC)",
  ];
  const rows = data.shops.map((s) => [
    s.publicId, s.name, s.city, s.status, ADOPTION_LABELS[s.adoption], s.completedVisits, s.appointmentsCompleted,
    s.walkInsServed, s.cancelled, s.noShow, (s.serviceValuePaise / 100).toFixed(2), s.registeredAt,
  ]);
  const meta = [`Period ${data.from} to ${data.to} (${data.timeZone}); generated ${data.generatedAt}`];
  return [meta, header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
