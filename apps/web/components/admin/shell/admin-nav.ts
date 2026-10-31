import { Role } from "@barbercue/shared";
import type { IconName } from "../../owner/icons";
import { canOpenAdminPath } from "../../../lib/admin-route-access";

// The ONE definition of the admin app's navigation (sidebar, icon rail and the "planned" pages all
// read it). `live` items are real pages backed by real data. `planned` items exist so the structure
// of Admin Dashboard 2.1 is visible, but they open an honest "not built yet" page that names the
// data FastQue still has to record - never a mock-up with invented numbers.

export type AdminNavGroupId =
  | "DASHBOARD"
  | "SHOPS"
  | "BOOKINGS"
  | "SERVICES"
  | "REVENUE"
  | "STAFF"
  | "CUSTOMERS"
  | "SALES"
  | "OPERATIONS"
  | "INVENTORY"
  | "ANALYTICS"
  | "ALERTS"
  | "REPORTS"
  | "SETTINGS";

export interface AdminNavItem {
  id: string;
  label: string;
  group: AdminNavGroupId;
  /** Pathname (no query); `query` selects a preset within the page. */
  href: string;
  query?: string;
  status: "live" | "planned";
  /** For planned items: what has to exist before the page can show real numbers. */
  needs?: string;
}

export const ADMIN_NAV_GROUPS: ReadonlyArray<{ id: AdminNavGroupId; label: string; icon: IconName }> = [
  { id: "DASHBOARD", label: "Dashboard", icon: "home" },
  { id: "SHOPS", label: "Shops", icon: "store" },
  { id: "BOOKINGS", label: "Bookings", icon: "calendar" },
  { id: "SERVICES", label: "Services", icon: "scissors" },
  { id: "REVENUE", label: "Revenue", icon: "rupee" },
  { id: "STAFF", label: "Staff", icon: "team" },
  { id: "CUSTOMERS", label: "Customers", icon: "users" },
  { id: "SALES", label: "Regional Sales", icon: "trend" },
  { id: "OPERATIONS", label: "Operations", icon: "queue" },
  { id: "INVENTORY", label: "Inventory", icon: "tag" },
  { id: "ANALYTICS", label: "Analytics", icon: "chart" },
  { id: "ALERTS", label: "Alerts", icon: "alert" },
  { id: "REPORTS", label: "Reports", icon: "receipt" },
  { id: "SETTINGS", label: "Settings", icon: "settings" },
];

const CHARTS = "/dashboard/admin/analytics/chart-builder";
const STATUS = "/dashboard/admin/shops/status";
const planned = (group: AdminNavGroupId, id: string, label: string, needs: string): AdminNavItem => ({
  id,
  label,
  group,
  href: `/dashboard/admin/planned/${id}`,
  status: "planned",
  needs,
});

export const ADMIN_NAV_ITEMS: ReadonlyArray<AdminNavItem> = [
  { id: "executive", label: "Executive Overview", group: "DASHBOARD", href: "/dashboard/admin/command-center", status: "live" },
  { id: "trends", label: "Performance Trends", group: "DASHBOARD", href: CHARTS, query: "preset=visits", status: "live" },
  planned("DASHBOARD", "kpi-comparison", "KPI Comparison", "A shop/city comparison API (geography filters)."),

  { id: "all-shops", label: "All Shops", group: "SHOPS", href: "/dashboard/admin", status: "live" },
  { id: "open-closed", label: "Open / Closed Shops", group: "SHOPS", href: STATUS, status: "live" },
  planned("SHOPS", "shop-onboarding", "New Shop Onboarding", "Salon lifecycle events (registered → verified → configured → first booking)."),
  planned("SHOPS", "shop-rankings", "Shop Rankings", "A paginated shop-ranking API with geography filters."),

  { id: "booking-trends", label: "Booking Trends", group: "BOOKINGS", href: CHARTS, query: "preset=bookings", status: "live" },
  planned("BOOKINGS", "all-bookings", "All Bookings", "A paginated, privacy-safe booking list API for admins."),

  planned("SERVICES", "service-performance", "Service Performance", "A canonical platform service-category mapping."),

  { id: "business-value", label: "Overall Business Value", group: "REVENUE", href: CHARTS, query: "preset=value", status: "live" },
  planned("REVENUE", "platform-revenue", "FastQue Platform Revenue", "A platform-fee ledger (commissions, fees, subscriptions) — not recorded today."),
  planned("REVENUE", "settlements", "Payment & Settlement Reports", "Settlement records from the payment provider."),

  { id: "staff-overview", label: "Staff Overview", group: "STAFF", href: "/dashboard/admin/staff", status: "live" },
  { id: "staff-export", label: "Staff Data Export", group: "STAFF", href: "/dashboard/admin/staff", query: "view=export", status: "live" },

  { id: "customer-trends", label: "Customer Booking Trends", group: "CUSTOMERS", href: CHARTS, query: "preset=customers", status: "live" },
  { id: "customer-overview", label: "Customer Overview", group: "CUSTOMERS", href: "/dashboard/admin/customers", status: "live" },
  { id: "customer-export", label: "Customer Data Export", group: "CUSTOMERS", href: "/dashboard/admin/customers", query: "view=export", status: "live" },

  { id: "field-crm", label: "Field CRM", group: "SALES", href: "/dashboard/admin/crm", status: "live" },
  { id: "crm-analytics", label: "Sales Executives", group: "SALES", href: "/dashboard/admin/crm/analytics", status: "live" },
  planned("SALES", "regions", "Regional Managers & Cities", "Sales territories, effective-dated assignments and targets."),

  { id: "shop-status-ops", label: "Open / Closed Monitoring", group: "OPERATIONS", href: STATUS, query: "view=hourly", status: "live" },
  { id: "waiting-time", label: "Waiting Time Analysis", group: "OPERATIONS", href: CHARTS, query: "preset=wait", status: "live" },
  planned("OPERATIONS", "live-queue", "Live Queue Monitoring", "A national live-queue read model (per-shop data exists)."),
  planned("OPERATIONS", "chair-utilization", "Chair Utilization", "Phase 3 utilisation model (chairs × operating hours × sessions)."),

  { id: "chart-builder", label: "Chart Builder", group: "ANALYTICS", href: CHARTS, status: "live" },
  planned("ANALYTICS", "saved-reports", "Saved Reports", "Server-side saved chart preferences (stored per browser today)."),

  { id: "inventory-overview", label: "Inventory Overview", group: "INVENTORY", href: "/dashboard/admin/inventory", status: "live" },
  { id: "product-catalog", label: "Product Catalog", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", status: "live" },
  { id: "catalog-import", label: "Catalog Import", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "view=import", status: "live" },

  { id: "quiet-shops", label: "Open, No Bookings", group: "ALERTS", href: STATUS, query: "filter=quiet", status: "live" },
  planned("ALERTS", "inactive-alerts", "Inactive Shop Alerts", "Alert rules, alert records and assignable follow-ups."),

  planned("REPORTS", "exports", "Data Exports", "Server-generated, audited exports."),

  { id: "admin-users", label: "Admin Users", group: "SETTINGS", href: "/dashboard/admin/access", status: "live" },
  { id: "employees", label: "Employees", group: "SETTINGS", href: "/dashboard/admin/employees", status: "live" },
  { id: "verification", label: "Verification Queue", group: "SETTINGS", href: "/dashboard/admin/verification", status: "live" },
  { id: "location-proposals", label: "Location Proposals", group: "SETTINGS", href: "/dashboard/admin/location-proposals", status: "live" },
  planned("SETTINGS", "alert-thresholds", "Alert & KPI Thresholds", "Admin-editable thresholds (fixed in code today)."),
];

export const hrefOf = (item: AdminNavItem) => (item.query ? `${item.href}?${item.query}` : item.href);

/** Items this user may open. Planned pages are visible to every internal admin. */
export function adminNavFor(roles: Role[]): AdminNavItem[] {
  return ADMIN_NAV_ITEMS.filter((item) => item.status === "planned" || canOpenAdminPath(roles, item.href));
}

/** The sidebar item for the current URL: exact path + query first, then path alone, then prefix. */
export function activeAdminItem(items: readonly AdminNavItem[], pathname: string, search: string): AdminNavItem | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(search);
  const withQuery = items.find(
    (i) => i.href === path && i.query && [...new URLSearchParams(i.query)].every(([k, v]) => params.get(k) === v),
  );
  if (withQuery) return withQuery;
  const exact = items.find((i) => i.href === path && !i.query) ?? items.find((i) => i.href === path);
  if (exact) return exact;
  return (
    [...items]
      .filter((i) => i.href !== "/dashboard/admin" && path.startsWith(`${i.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0] ?? null
  );
}

export function plannedItem(id: string): AdminNavItem | null {
  return ADMIN_NAV_ITEMS.find((i) => i.status === "planned" && i.id === id) ?? null;
}
