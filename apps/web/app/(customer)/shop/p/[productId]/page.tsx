import { ShopProduct } from "../../../../../components/shop/Shop";

export default async function ShopProductPage({ params, searchParams }: { params: Promise<{ productId: string }>; searchParams: Promise<{ city?: string }> }) {
  const [{ productId }, { city }] = await Promise.all([params, searchParams]);
  return <ShopProduct globalProductId={productId} cityId={city} />;
}
