import { Role } from "@barbercue/shared";
import {
  isWorkspaceUser,
  workspaceLandingPath,
  workspaceNavigationLabel,
} from "../../../lib/workspace-route";

describe("internal admin workspace routing", () => {
  test.each([
    Role.PLATFORM_ADMIN,
    Role.CO_FOUNDER,
    Role.HR_ADMIN,
    Role.SALES_ADMIN,
    Role.PLATFORM_VIEWER,
  ])("routes %s into the admin workspace", (role) => {
    const user = { roles: [role] };

    expect(workspaceLandingPath(user)).toBe("/dashboard/admin");
    expect(isWorkspaceUser(user)).toBe(true);
    expect(workspaceNavigationLabel(user)).toBe("Admin dashboard");
  });

  test("keeps customer-only users in the customer account", () => {
    const user = { roles: [Role.CUSTOMER] };

    expect(workspaceLandingPath(user)).toBe("/account");
    expect(isWorkspaceUser(user)).toBe(false);
    expect(workspaceNavigationLabel(user)).toBe("My account");
  });
});
