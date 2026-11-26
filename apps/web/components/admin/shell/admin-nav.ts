import { Role } from "@barbercue/shared";
import type { IconName } from "../../owner/icons";
import { canOpenAdminPath } from "../../../lib/admin-route-access";
import { ADMIN_HOME_TABS } from "../../home/admin-home-tabs";
import { directCommerceLinksEnabled, workMarketplaceLinksEnabled } from "../../../lib/dashboard-flags";

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
  | "HOME_SERVICES"
  | "INVENTORY"
  | "COMMERCE"
  | "FINANCE"
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
  { id: "HOME_SERVICES", label: "FastQue Home", icon: "home" },
  { id: "INVENTORY", label: "Inventory", icon: "tag" },
  ...(directCommerceLinksEnabled() ? [{ id: "COMMERCE" as const, label: "FastQue Commerce", icon: "store" as const }] : []),
  { id: "FINANCE", label: "Finance", icon: "card" },
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

const COMMERCE = "/dashboard/admin/commerce";
const COMMERCE_TABS: ReadonlyArray<readonly [string, string]> = [
  ["overview", "Overview"],
  ["products", "Products & Pricing"],
  ["inventory", "Inventory"],
  ["warehouses", "Warehouses"],
  ["suppliers", "Suppliers & Distributors"],
  ["procurement", "Procurement"],
  ["orders", "Orders"],
  ["shipping", "Shipping & Delivery"],
  ["cod", "COD Management"],
  ["returns", "Returns & Replacements"],
  ["support", "Support & Reviews"],
  ["promotions", "Promotions"],
  ["serviceability", "Delivery Serviceability"],
  ["reports", "Analytics & Reports"],
  ["insights", "AI Insights"],
  ["quality", "Product Data Quality"],
  ["settings", "Settings"],
];

export const ADMIN_NAV_ITEMS: ReadonlyArray<AdminNavItem> = [
  { id: "executive", label: "Executive Overview", group: "DASHBOARD", href: "/dashboard/admin/command-center", status: "live" },
  { id: "trends", label: "Performance Trends", group: "DASHBOARD", href: CHARTS, query: "preset=visits", status: "live" },
  planned("DASHBOARD", "kpi-comparison", "KPI Comparison", "A shop/city comparison API (geography filters)."),

  { id: "all-shops", label: "All Shops", group: "SHOPS", href: "/dashboard/admin", status: "live" },
  { id: "open-closed", label: "Open / Closed Shops", group: "SHOPS", href: STATUS, status: "live" },
  { id: "shop-onboarding", label: "New Shop Onboarding", group: "SHOPS", href: "/dashboard/admin/onboarding", status: "live" },
  planned("SHOPS", "shop-rankings", "Shop Rankings", "A paginated shop-ranking API with geography filters."),

  { id: "booking-trends", label: "Booking Trends", group: "BOOKINGS", href: CHARTS, query: "preset=bookings", status: "live" },
  { id: "all-bookings", label: "All Bookings", group: "BOOKINGS", href: "/dashboard/admin/bookings", status: "live" },

  planned("SERVICES", "service-performance", "Service Performance", "A canonical platform service-category mapping."),

  { id: "business-value", label: "Overall Business Value", group: "REVENUE", href: CHARTS, query: "preset=value", status: "live" },
  planned("REVENUE", "platform-revenue", "FastQue Platform Revenue", "A platform-fee ledger (commissions, fees, subscriptions) — not recorded today."),
  planned("REVENUE", "settlements", "Payment & Settlement Reports", "Settlement records from the payment provider."),

  { id: "staff-overview", label: "Staff Overview", group: "STAFF", href: "/dashboard/admin/staff", status: "live" },
  { id: "staff-export", label: "Staff Data Export", group: "STAFF", href: "/dashboard/admin/staff", query: "view=export", status: "live" },

  { id: "customer-trends", label: "Customer Booking Trends", group: "CUSTOMERS", href: CHARTS, query: "preset=customers", status: "live" },
  { id: "customer-overview", label: "Customer Overview", group: "CUSTOMERS", href: "/dashboard/admin/customers", status: "live" },
  { id: "customer-export", label: "Customer Data Export", group: "CUSTOMERS", href: "/dashboard/admin/customers", query: "view=export", status: "live" },

  { id: "field-crm-2", label: "Field CRM 2.0", group: "SALES", href: "/dashboard/admin/field-crm", status: "live" },
  { id: "onboarding-review", label: "Onboarding Review", group: "SALES", href: "/dashboard/admin/onboarding-review", status: "live" },
  { id: "field-crm", label: "Field CRM", group: "SALES", href: "/dashboard/admin/crm", status: "live" },
  { id: "crm-analytics", label: "Sales Executives", group: "SALES", href: "/dashboard/admin/crm/analytics", status: "live" },
  planned("SALES", "regions", "Regional Managers & Cities", "Sales territories, effective-dated assignments and targets."),

  { id: "shop-status-ops", label: "Open / Closed Monitoring", group: "OPERATIONS", href: STATUS, query: "view=hourly", status: "live" },
  { id: "waiting-time", label: "Waiting Time Analysis", group: "OPERATIONS", href: CHARTS, query: "preset=wait", status: "live" },
  { id: "live-queue", label: "Live Queue Monitoring", group: "OPERATIONS", href: "/dashboard/admin/live-queue", status: "live" },
  // Shown as live only once the marketplace is switched on (NEXT_PUBLIC_WORK_MARKETPLACE_ENABLED).
  workMarketplaceLinksEnabled()
    ? { id: "work-marketplace", label: "FastQue Work", group: "OPERATIONS", href: "/dashboard/admin/work", status: "live" }
    : planned("OPERATIONS", "work-marketplace", "FastQue Work", "Switched off: set WORK_MARKETPLACE_ENABLED on the backend and NEXT_PUBLIC_WORK_MARKETPLACE_ENABLED on the website."),
  planned("OPERATIONS", "chair-utilization", "Chair Utilization", "Phase 3 utilisation model (chairs × operating hours × sessions)."),

  // FastQue Home (docs/home/). Always listed: administrators resolve existing bookings even while the switches are off.
  ...ADMIN_HOME_TABS.map(
    (tab): AdminNavItem => ({ id: `home-${tab.id}`, label: tab.label, group: "HOME_SERVICES", href: "/dashboard/admin/home", query: tab.id === "overview" ? undefined : `tab=${tab.id}`, status: "live" }),
  ),

  { id: "chart-builder", label: "Chart Builder", group: "ANALYTICS", href: CHARTS, status: "live" },
  planned("ANALYTICS", "saved-reports", "Saved Reports", "Server-side saved chart preferences (stored per browser today)."),

  { id: "inventory-overview", label: "Inventory Statistics", group: "INVENTORY", href: "/dashboard/admin/inventory", status: "live" },
  { id: "product-catalog", label: "Product Master", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "status=VERIFIED", status: "live" },
  { id: "inventory-upload", label: "Upload Inventory", group: "INVENTORY", href: "/dashboard/admin/inventory/upload", status: "live" },
  { id: "inventory-upload-history", label: "Upload History", group: "INVENTORY", href: "/dashboard/admin/inventory/uploads", status: "live" },
  { id: "shop-products", label: "Shop-Specific Products", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "status=&visibility=SHOP", status: "live" },
  { id: "product-search", label: "Product Search", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "status=&focus=search", status: "live" },
  { id: "catalog-review", label: "Catalog Review", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "status=PENDING", status: "live" },
  { id: "catalog-change-requests", label: "Owner Change Requests", group: "INVENTORY", href: "/dashboard/admin/inventory/change-requests", status: "live" },
  { id: "catalog-import", label: "Catalog CSV Import (basic)", group: "INVENTORY", href: "/dashboard/admin/inventory/catalog", query: "view=import", status: "live" },
  { id: "marketplace", label: "Marketplace", group: "INVENTORY", href: "/dashboard/admin/marketplace", status: "live" },
  { id: "marketplace-approvals", label: "Listing Approvals", group: "INVENTORY", href: "/dashboard/admin/marketplace", query: "tab=listings", status: "live" },
  { id: "marketplace-orders", label: "Shop Orders", group: "INVENTORY", href: "/dashboard/admin/marketplace", query: "tab=orders", status: "live" },

  // FastQue Direct Commerce appears only once it is switched on for this website build.
  ...(directCommerceLinksEnabled()
    ? [
        ...COMMERCE_TABS.map(([id, label]): AdminNavItem => ({ id: `commerce-${id}`, label, group: "COMMERCE", href: COMMERCE, ...(id === "overview" ? {} : { query: `tab=${id}` }), status: "live" })),
      ]
    : []),

  { id: "finance-overview", label: "Overview", group: "FINANCE", href: "/dashboard/admin/finance", status: "live" },
  { id: "finance-expenses", label: "Expenses", group: "FINANCE", href: "/dashboard/admin/finance", query: "tab=expenses", status: "live" },
  { id: "finance-funding", label: "Contributions & Funding", group: "FINANCE", href: "/dashboard/admin/finance", query: "tab=funding", status: "live" },
  { id: "finance-reimbursements", label: "Reimbursements", group: "FINANCE", href: "/dashboard/admin/finance", query: "tab=reimbursements", status: "live" },
  planned("FINANCE", "finance-budgets", "Budgets", "Budget records by category, city and month, with revisions and 75/90/100% alerts (finance Phase 4)."),
  { id: "finance-vendors", label: "Vendors & Payments", group: "FINANCE", href: "/dashboard/admin/finance", query: "tab=vendors", status: "live" },
  planned("FINANCE", "finance-reports", "Reports & Analytics", "Excel/PDF statements, budget-vs-actual, forecasts and salon acquisition cost (finance Phases 4-5)."),
  { id: "finance-settings", label: "Settings & Categories", group: "FINANCE", href: "/dashboard/admin/finance", query: "tab=settings", status: "live" },

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

export type AdminNavGroup = (typeof ADMIN_NAV_GROUPS)[number];

/** The main-rail sections that still have at least one item this user may open (empty ones are hidden). */
export function adminNavGroupsFor(items: readonly AdminNavItem[]): AdminNavGroup[] {
  return ADMIN_NAV_GROUPS.filter((g) => items.some((i) => i.group === g.id));
}

/**
 * The section whose items the sub-sidebar shows: the one the user picked in the rail, else the one
 * containing the current page, else the first visible section. A pick the role cannot see is ignored.
 */
export function selectedAdminGroup(
  groups: readonly AdminNavGroup[],
  picked: AdminNavGroupId | null,
  active: AdminNavItem | null,
): AdminNavGroup | null {
  return groups.find((g) => g.id === picked) ?? groups.find((g) => g.id === active?.group) ?? groups[0] ?? null;
}

export function plannedItem(id: string): AdminNavItem | null {
  return ADMIN_NAV_ITEMS.find((i) => i.status === "planned" && i.id === id) ?? null;
}
