import { ProductUsageView } from "../../../../../../../components/owner/inventory/ServiceUsageViews";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <ProductUsageView salonId={salonId} />;
}
