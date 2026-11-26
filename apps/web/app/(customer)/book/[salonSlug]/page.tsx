import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DISCOVERY_PATHS } from "@barbercue/shared";
import type { PublicSalonStatusDto, SalonProfileDto } from "@barbercue/shared";
import { fetchDiscoveryOrNull } from "../../../../lib/discovery-api";
import { BookingFlow } from "../../../../components/booking/BookingFlow";
import { MetaSalonView } from "../../../../components/analytics/MetaPixel";
import { CampaignCapture } from "../../../../components/booking/CampaignCapture";
import { salonKey } from "../../../../lib/campaign-token";
import { isOfferId } from "../../../../lib/public-offers";
import { EditorialImage } from "../../../../components/editorial/EditorialImage";
import { PublicSalonStatus } from "../../../../components/discovery/PublicSalonStatus";
import styles from "./book.module.css";

interface BookPageParams {
  salonSlug: string;
}

// Authenticated, customer-specific flow — never indexable. See robots.ts.
// A cross-origin link from this page never receives its address, only its origin (a campaign code may be in the address for a moment).
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "strict-origin-when-cross-origin" };

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<BookPageParams>;
  searchParams: Promise<{ city?: string; country?: string; style?: string; serviceId?: string; staffId?: string; offer?: string }>;
}) {
  const { salonSlug } = await params;
  const { city, country, style, serviceId, staffId, offer } = await searchParams;
  // Multi-service booking core mission — `serviceId` accepts a comma-separated list (set by
  // rebookUrl/AI Style Advisor hand-off) so "Book again" can carry a previous appointment's
  // COMPLETE service selection, not just its first service. A bare single id still works
  // unchanged (a one-element list).
  const initialServiceIds = serviceId
    ? serviceId.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;
  // Salon.slug is unique only per city, and City.slug is unique only per country (B9), so the
  // salon profile page's "Book an appointment" link always passes both alongside the slug.
  if (!city || !country) notFound();

  // revalidate: 0 (no caching) — unlike the public salon profile page's 5-minute ISR window, a
  // customer one click from booking needs live services/operating-hours data, not a stale cache.
  const salon = await fetchDiscoveryOrNull<SalonProfileDto>(
    `${DISCOVERY_PATHS.salons}/${country}/${city}/${salonSlug}`,
    0,
  );
  if (!salon) notFound();
  // Same key the public shop page uses, so a campaign code captured there reaches this flow (and a code on this URL works too).
  const campaignKey = salonKey(country, city, salonSlug);
  const publicStatus = await fetchDiscoveryOrNull<PublicSalonStatusDto>(
    `${DISCOVERY_PATHS.salons}/${country}/${city}/${salonSlug}/${DISCOVERY_PATHS.status}`,
    0,
  ).catch(() => null);

  return (
    <main className={styles.page}>
      <MetaSalonView key={salon.id} />
      <div className={styles.banner} aria-hidden="true">
        <EditorialImage id="process-haircut" fill priority sizes="(max-width: 760px) 100vw, 760px" />
        <div className={styles.bannerScrim} />
        <p className={styles.bannerCaption}>Precision, comfort, and a chair that&apos;s ready when you are.</p>
      </div>

      <div className={styles.header}>
        <p className={styles.eyebrow}>Booking</p>
        <h1>Book at {salon.name}</h1>
        <p className={styles.address}>{salon.addressLine}</p>
      </div>

      {publicStatus && <PublicSalonStatus status={publicStatus} compact />}

      <CampaignCapture salonKey={campaignKey} />
      <BookingFlow
        campaignKey={campaignKey}
        // An offer chosen on the public Offers page; the booking flow looks it up and the server decides eligibility.
        offerId={isOfferId(offer) ? offer : undefined}
        offerCity={city}
        salonId={salon.id}
        services={salon.services}
        operatingHours={salon.operatingHours}
        currency={salon.currency}
        countryCode={salon.countryCode}
        salonTimezone={salon.salonTimezone}
        onlineBookingDiscountPercent={salon.onlineBookingDiscountPercent ?? 0}
        selectedStyleName={style}
        initialServiceIds={initialServiceIds}
        // A prefilled service (rebook or style hand-off) always came with an explicit staff choice
        // already made on the original booking — default to "Any Staff" (null) rather than leaving
        // the picker unset, unless a specific staffId was actually carried over.
        initialStaffId={initialServiceIds ? (staffId ?? null) : undefined}
      />
    </main>
  );
}
