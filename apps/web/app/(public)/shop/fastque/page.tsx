import type { Metadata } from "next";
import { Suspense } from "react";
import { FastQueStore } from "../../../../components/commerce/FastQueStore";

export const metadata: Metadata = { title: "Shop from FastQue", description: "Hair, skin and grooming products sold and delivered by FastQue.", robots: { index: false } };

export default function FastQueShopPage() {
  return (
    <Suspense fallback={null}>
      <FastQueStore />
    </Suspense>
  );
}
