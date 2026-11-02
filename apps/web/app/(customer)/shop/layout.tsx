import type { ReactNode } from "react";
import { CustomerShell } from "../../../components/layout/CustomerShell";

// Inventory Phase 5: "Shop products" — browsing is open to everyone; ordering asks for a customer sign-in.
export default function ShopLayout({ children }: { children: ReactNode }) {
  return <CustomerShell>{children}</CustomerShell>;
}
