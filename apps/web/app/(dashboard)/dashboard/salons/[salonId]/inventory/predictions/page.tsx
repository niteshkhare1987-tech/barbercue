import { PredictionsView } from "../../../../../../../components/owner/inventory/ForecastViews";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <PredictionsView salonId={salonId} />;
}
