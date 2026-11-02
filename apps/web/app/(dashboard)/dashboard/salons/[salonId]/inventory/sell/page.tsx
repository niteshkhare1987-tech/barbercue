import { SellView } from "../../../../../../../components/owner/inventory/CommerceViews";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <SellView salonId={salonId} />;
}
