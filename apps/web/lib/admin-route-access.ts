import { Role, hasAdminPermission } from "@barbercue/shared";

const INTERNAL_ADMIN_ROLES: ReadonlySet<Role> = new Set([
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.HR_ADMIN,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
]);

/** Client-side route affordance only; backend RolesGuard remains authoritative. */
export function canOpenAdminPath(roles: Role[], pathname: string): boolean {
  const internalAdmin = roles.some((role) => INTERNAL_ADMIN_ROLES.has(role));
  if (!internalAdmin) return false;

  const superAdmin = roles.includes(Role.PLATFORM_ADMIN);
  const coFounder = roles.includes(Role.CO_FOUNDER);
  const hr = roles.includes(Role.HR_ADMIN);
  const sales = roles.includes(Role.SALES_ADMIN);

  if (pathname === "/dashboard/admin") return true;
  // Live shop status and the "planned feature" explainers carry no contact details: every internal role.
  if (pathname.startsWith("/dashboard/admin/shops/status") || pathname.startsWith("/dashboard/admin/planned/")) return true;
  // Customers / salon staff analytics: the same permissions the backend routes enforce.
  if (pathname.startsWith("/dashboard/admin/customers")) return hasAdminPermission(roles, "viewCustomerAnalytics");
  if (pathname.startsWith("/dashboard/admin/staff")) return hasAdminPermission(roles, "viewStaffAnalytics");
  // Chart builder: same audience as GET admin/analytics/timeseries.
  if (pathname.startsWith("/dashboard/admin/analytics")) {
    return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  }
  // Executive Command Center: mirrors GET admin/analytics/overview (PLATFORM_ADMIN, CO_FOUNDER, PLATFORM_VIEWER).
  if (pathname.startsWith("/dashboard/admin/command-center")) {
    return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  }
  // Inventory overview and catalog: same audience as GET admin/inventory-overview and inventory-catalog.
  // (Catalog review and import are further limited to PLATFORM_ADMIN / CO_FOUNDER on the server.)
  // Marketplace control: same audience as GET admin/shop/* (approvals are admin/co-founder on the server).
  if (pathname.startsWith("/dashboard/admin/marketplace")) {
    return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  }
  // FastQue Commerce: every internal admin may open it; each tab needs a permission the server checks.
  if (pathname.startsWith("/dashboard/admin/commerce")) return true;
  if (pathname.startsWith("/dashboard/admin/inventory")) {
    return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  }
  // Finance: every internal role may file and track its OWN expenses and claims; company-wide figures are
  // limited server-side (FINANCE_PERMISSION_ROLES) and the page hides the tabs a role cannot use.
  if (pathname.startsWith("/dashboard/admin/finance")) return true;
  // Live queue monitoring is counts-only: every internal admin role, like shop activity (GET admin/live-queue).
  if (pathname.startsWith("/dashboard/admin/live-queue")) return true;
  // All Bookings: mirrors GET admin/bookings (PLATFORM_ADMIN, CO_FOUNDER, PLATFORM_VIEWER).
  if (pathname.startsWith("/dashboard/admin/bookings")) return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  // New Shop Onboarding: mirrors GET admin/onboarding (PLATFORM_ADMIN, CO_FOUNDER, SALES_ADMIN, PLATFORM_VIEWER).
  if (pathname.startsWith("/dashboard/admin/onboarding")) return superAdmin || coFounder || sales || roles.includes(Role.PLATFORM_VIEWER);
  // FastQue Work control centre: mirrors GET work/admin/* (PLATFORM_ADMIN, CO_FOUNDER, PLATFORM_VIEWER; writes PLATFORM_ADMIN).
  if (pathname.startsWith("/dashboard/admin/work")) return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  // FastQue Home: mirrors GET admin/home/* (addresses, documents and safety reports are limited further on the server).
  if (pathname.startsWith("/dashboard/admin/home")) return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  if (pathname.startsWith("/dashboard/admin/access")) return superAdmin;
  // Salon onboarding review queue: mirrors GET admin/onboarding-applications (decisions stay PLATFORM_ADMIN / CO_FOUNDER server-side).
  if (pathname.startsWith("/dashboard/admin/onboarding-review")) {
    return superAdmin || coFounder || sales || roles.includes(Role.PLATFORM_VIEWER);
  }
  // Field CRM 2.0 (manager/admin views): mirrors the crm/* API roles (SALES_ADMIN, PLATFORM_ADMIN, CO_FOUNDER; PLATFORM_VIEWER read-only).
  if (pathname.startsWith("/dashboard/admin/field-crm")) return superAdmin || coFounder || sales || roles.includes(Role.PLATFORM_VIEWER);
  // The platform CRM analytics and its cursor-paged rows are PLATFORM_ADMIN only on the server (ADMIN_CRM_ANALYTICS_V1).
  if (pathname.startsWith("/dashboard/admin/crm/analytics")) return superAdmin;
  if (pathname.startsWith("/dashboard/admin/crm")) return superAdmin || coFounder || hr || sales;
  if (pathname.startsWith("/dashboard/admin/employees")) return superAdmin || coFounder || hr;
  if (pathname.startsWith("/dashboard/admin/verification")) return superAdmin || coFounder;
  return superAdmin || coFounder;
}

/** Offer letters are HR functionality, not part of Sales' otherwise shared CRM workspace. */
export function canGenerateOfferLetter(roles: Role[]): boolean {
  return roles.includes(Role.PLATFORM_ADMIN) || roles.includes(Role.CO_FOUNDER) || roles.includes(Role.HR_ADMIN);
}
