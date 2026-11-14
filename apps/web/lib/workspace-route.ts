import { Role, type MeResponse } from "@barbercue/shared";
import { readLastShop } from "./last-shop";
import { shopHomePath } from "./shop-home";

const ADMIN_WORKSPACE_ROLES: ReadonlySet<Role> = new Set([
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.HR_ADMIN,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
]);

/** Route from roles returned by the server, never from which login button the user clicked. */
export function workspaceLandingPath(user: MeResponse): string {
  if (user.roles.includes(Role.FIELD_EXECUTIVE)) return "/employee";
  if (user.roles.some((role) => ADMIN_WORKSPACE_ROLES.has(role))) return "/dashboard/admin";
  if (user.roles.includes(Role.SALON_OWNER) || user.roles.includes(Role.SALON_STAFF)) {
    return ownerHomePath(user);
  }
  // Customer dashboard home (Discover, appointments, rewards…); /account/bookings is My Appointments.
  return "/account";
}

/**
 * An owner's or barber's dashboard home: the shop they used last (the dashboard page re-checks it
 * against the shops the server lists for them), otherwise the page that picks the shop for them - a
 * single-shop owner goes straight through it to their shop home.
 */
export function ownerHomePath(user: Pick<MeResponse, "id">): string {
  const last = readLastShop(user.id);
  return last ? shopHomePath(last) : "/dashboard/salons";
}

/** True when the current session belongs to an operational workspace rather than a customer account. */
export function isWorkspaceUser(user: MeResponse): boolean {
  return user.roles.some((role) =>
    ADMIN_WORKSPACE_ROLES.has(role) ||
      role === Role.SALON_OWNER ||
      role === Role.SALON_STAFF ||
      role === Role.FIELD_EXECUTIVE,
  );
}

/** Keep public navigation labels aligned with the role-scoped destination we actually expose. */
export function workspaceNavigationLabel(user: MeResponse): string {
  if (user.roles.includes(Role.FIELD_EXECUTIVE)) return "Employee dashboard";
  if (user.roles.some((role) => ADMIN_WORKSPACE_ROLES.has(role))) return "Admin dashboard";
  if (user.roles.includes(Role.SALON_OWNER)) return "Owner dashboard";
  if (user.roles.includes(Role.SALON_STAFF)) return "Back to dashboard";
  return "My account";
}
