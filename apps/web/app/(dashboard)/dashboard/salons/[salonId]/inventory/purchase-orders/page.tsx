import { PurchaseOrdersView } from "../../../../../../../components/owner/inventory/CommerceViews";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <PurchaseOrdersView salonId={salonId} />;
}
