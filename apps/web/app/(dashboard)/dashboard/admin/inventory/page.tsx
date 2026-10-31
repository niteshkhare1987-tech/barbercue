import { Suspense } from "react";
import { AdminInventoryOverview } from "../../../../../components/admin/inventory/AdminInventoryOverview";

export default function AdminInventoryPage() {
  return (
    <Suspense fallback={null}>
      <AdminInventoryOverview />
    </Suspense>
  );
}
