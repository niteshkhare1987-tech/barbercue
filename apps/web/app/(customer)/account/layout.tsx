"use client";

import { Role } from "@barbercue/shared";
import { RequireRole } from "../../../components/auth/RequireRole";
import { CustomerShell } from "../../../components/layout/CustomerShell";
import { CustomerActionAssistant } from "../../../components/assistant/CustomerActionAssistant";
import { DashboardShell } from "../../../components/customer-dashboard/DashboardShell";

// Customer dashboard (docs/customer-dashboard/PROGRESS.md). Every /account page is signed-in
// customers only; guests keep full public discovery at /search and the salon pages.
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole roles={[Role.CUSTOMER]} redirectTo="/login">
      <CustomerShell>
        <DashboardShell>{children}</DashboardShell>
        <CustomerActionAssistant />
      </CustomerShell>
    </RequireRole>
  );
}
