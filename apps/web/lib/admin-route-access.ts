import { Role } from "@barbercue/shared";

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
  // Executive Command Center: mirrors GET admin/analytics/overview (PLATFORM_ADMIN, CO_FOUNDER, PLATFORM_VIEWER).
  if (pathname.startsWith("/dashboard/admin/command-center")) {
    return superAdmin || coFounder || roles.includes(Role.PLATFORM_VIEWER);
  }
  if (pathname.startsWith("/dashboard/admin/access")) return superAdmin;
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
