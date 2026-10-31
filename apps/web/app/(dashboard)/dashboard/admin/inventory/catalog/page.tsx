import { Suspense } from "react";
import { AdminProductCatalog } from "../../../../../../components/admin/inventory/AdminProductCatalog";

export default function AdminProductCatalogPage() {
  return (
    <Suspense fallback={null}>
      <AdminProductCatalog />
    </Suspense>
  );
}
