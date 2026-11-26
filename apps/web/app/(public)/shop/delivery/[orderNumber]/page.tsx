import type { Metadata } from "next";
import { Suspense } from "react";
import { FastQueOrder } from "../../../../../components/commerce/FastQueOrder";

export const metadata: Metadata = { title: "Your FastQue order", robots: { index: false }, referrer: "no-referrer" };

export default async function FastQueOrderPage({ params }: { params: Promise<{ orderNumber: string }> }) {
  const { orderNumber } = await params;
  return (
    <Suspense fallback={null}>
      <FastQueOrder orderNumber={orderNumber} />
    </Suspense>
  );
}
