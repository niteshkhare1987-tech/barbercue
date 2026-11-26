import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DISCOVERY_PATHS } from "@barbercue/shared";
import type { SalonProfileDto } from "@barbercue/shared";
import { fetchDiscoveryOrNull } from "../../../../lib/discovery-api";
import { WalkInJoinFlow } from "../../../../components/queue/WalkInJoinFlow";
import styles from "../../../../components/queue/queue.module.css";

interface QueuePageParams {
  salonSlug: string;
}

// Authenticated, customer-specific flow — never indexable. See robots.ts.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<QueuePageParams>;
  searchParams: Promise<{ city?: string; country?: string }>;
}) {
  const { salonSlug } = await params;
  const { city, country } = await searchParams;
  // Salon.slug is unique only per city, and City.slug only per country (B9) — same reason
  // book/[salonSlug]/page.tsx requires both.
  if (!city || !country) notFound();

  const salon = await fetchDiscoveryOrNull<SalonProfileDto>(
    `${DISCOVERY_PATHS.salons}/${country}/${city}/${salonSlug}`,
    0,
  );
  if (!salon) notFound();

  return (
    <main className={styles.page}>
      <h1 className={styles.pageTitle}>Join the queue at {salon.name}</h1>
      <p className={styles.pageSubtitle}>{salon.addressLine}</p>
      <WalkInJoinFlow salonId={salon.id} services={salon.services} currency={salon.currency} countryCode={salon.countryCode} />
    </main>
  );
}
