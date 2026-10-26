import { Role } from "@barbercue/shared";
import { canGenerateOfferLetter, canOpenAdminPath } from "../../../lib/admin-route-access";

describe("admin route boundary role matrix", () => {
  const paths = {
    overview: "/dashboard/admin",
    access: "/dashboard/admin/access",
    crm: "/dashboard/admin/crm",
    employees: "/dashboard/admin/employees",
    verification: "/dashboard/admin/verification",
    shops: "/dashboard/admin/shops",
    crmAnalytics: "/dashboard/admin/crm/analytics",
    commandCenter: "/dashboard/admin/command-center",
  };

  test.each([
    [Role.PLATFORM_ADMIN, [true, true, true, true, true, true, true, true]],
    [Role.CO_FOUNDER, [true, false, true, true, true, true, false, true]],
    [Role.HR_ADMIN, [true, false, true, true, false, false, false, false]],
    [Role.SALES_ADMIN, [true, false, true, false, false, false, false, false]],
    [Role.PLATFORM_VIEWER, [true, false, false, false, false, false, false, true]],
    [Role.CUSTOMER, [false, false, false, false, false, false, false, false]],
  ])("applies least-privilege web affordances for %s", (role, expected) => {
    const pathList = Object.values(paths);
    pathList.forEach((path, index) => {
      expect(canOpenAdminPath([role], path)).toBe(expected[index]);
    });
  });

  test("the CRM analytics pages, with or without a trailing slash, are for platform admins only", () => {
    for (const path of ["/dashboard/admin/crm/analytics", "/dashboard/admin/crm/analytics/"]) {
      expect(canOpenAdminPath([Role.PLATFORM_ADMIN], path)).toBe(true);
      for (const role of [Role.CO_FOUNDER, Role.HR_ADMIN, Role.SALES_ADMIN, Role.PLATFORM_VIEWER, Role.CUSTOMER, Role.BARBER]) {
        expect(canOpenAdminPath([role], path)).toBe(false);
      }
    }
    // A user who also holds a lesser internal role keeps the platform admin's access, and the older CRM page is unchanged.
    expect(canOpenAdminPath([Role.SALES_ADMIN, Role.PLATFORM_ADMIN], "/dashboard/admin/crm/analytics")).toBe(true);
    expect(canOpenAdminPath([Role.SALES_ADMIN], "/dashboard/admin/crm")).toBe(true);
  });

  test.each([
    [Role.PLATFORM_ADMIN, true],
    [Role.CO_FOUNDER, true],
    [Role.HR_ADMIN, true],
    [Role.SALES_ADMIN, false],
    [Role.PLATFORM_VIEWER, false],
  ])("keeps offer-letter tools scoped to HR/operations: %s", (role, expected) => {
    expect(canGenerateOfferLetter([role])).toBe(expected);
  });
});
