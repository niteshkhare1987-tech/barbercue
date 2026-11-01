import { ServiceRecipesView } from "../../../../../../../components/owner/inventory/ServiceUsageViews";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <ServiceRecipesView salonId={salonId} />;
}
