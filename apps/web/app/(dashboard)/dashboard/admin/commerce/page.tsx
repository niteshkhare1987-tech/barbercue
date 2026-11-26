import { Suspense } from "react";
import { AdminCommerce } from "../../../../../components/admin/commerce/AdminCommerce";

export default function AdminCommercePage() {
  return (
    <Suspense fallback={null}>
      <AdminCommerce />
    </Suspense>
  );
}
