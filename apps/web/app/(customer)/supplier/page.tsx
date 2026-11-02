"use client";

import { Role } from "@barbercue/shared";
import { RequireRole } from "../../../components/auth/RequireRole";
import { CustomerShell } from "../../../components/layout/CustomerShell";
import { SupplierPortal } from "../../../components/supplier/SupplierPortal";
import ui from "../../../components/owner/owner.module.css";

// Inventory Phase 4: the supplier portal. Suppliers sign in with an ordinary FastQue account;
// access to the price list and orders comes from FastQue approving their application.
export default function SupplierPage() {
  return (
    <RequireRole roles={[Role.CUSTOMER]} redirectTo="/login">
      <CustomerShell>
        <main className={ui.root} style={{ minHeight: "auto", padding: "24px 16px 64px", maxWidth: 1100, margin: "0 auto" }}>
          <SupplierPortal />
        </main>
      </CustomerShell>
    </RequireRole>
  );
}
