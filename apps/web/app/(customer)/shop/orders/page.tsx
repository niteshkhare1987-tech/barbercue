"use client";

import { Role } from "@barbercue/shared";
import { RequireRole } from "../../../../components/auth/RequireRole";
import { ShopOrders } from "../../../../components/shop/Shop";

export default function ShopOrdersPage() {
  return (
    <RequireRole roles={[Role.CUSTOMER]} redirectTo="/login">
      <ShopOrders />
    </RequireRole>
  );
}
