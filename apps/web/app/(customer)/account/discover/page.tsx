import type { Metadata } from "next";
import { Suspense } from "react";
import DiscoverClient from "./DiscoverClient";

export const metadata: Metadata = {
  title: "Discover salons",
  robots: { index: false, follow: false },
};

export default function DiscoverPage() {
  return (
    <Suspense fallback={null}>
      <DiscoverClient />
    </Suspense>
  );
}
