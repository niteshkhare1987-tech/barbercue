import { ScanAddStock } from "../../../../../../../components/owner/inventory/ScanAddStock";

export default async function Page({ params }: { params: Promise<{ salonId: string }> }) {
  const { salonId } = await params;
  return <ScanAddStock salonId={salonId} />;
}
