import type { Metadata } from "next";
import { FastQueCheckout } from "../../../../../components/commerce/FastQueBag";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

export default function FastQueCheckoutPage() {
  return <FastQueCheckout />;
}
