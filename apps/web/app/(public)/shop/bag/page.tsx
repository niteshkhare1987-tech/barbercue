import type { Metadata } from "next";
import { BagSwitch } from "../../../../components/commerce/FastQueBag";

export const metadata: Metadata = { title: "Your bag", robots: { index: false } };

export default function ShopBagPage() {
  return <BagSwitch />;
}
