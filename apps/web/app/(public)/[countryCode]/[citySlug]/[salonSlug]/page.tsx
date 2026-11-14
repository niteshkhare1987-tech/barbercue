import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DISCOVERY_PATHS, SHOP_CLOSED_TODAY_MESSAGE, VERIFICATION_BADGE_CAPTION, formatMoney } from "@barbercue/shared";
import type { CityDto, LocalityDto, PublicSalonStatusDto, SalonProfileDto } from "@barbercue/shared";
import { fetchDiscoveryOrNull } from "../../../../../lib/discovery-api";
import { absoluteUrl, DISCOVERY_REVALIDATE_SECONDS, SITE_URL } from "../../../../../lib/seo";
import { ServiceList } from "../../../../../components/discovery/ServiceList";
import { OperatingHoursTable } from "../../../../../components/discovery/OperatingHoursTable";
import { PhotoGallery } from "../../../../../components/discovery/PhotoGallery";
import { ReviewList } from "../../../../../components/discovery/ReviewList";
import { TeamSection } from "../../../../../components/discovery/TeamSection";
import { Breadcrumbs, breadcrumbJsonLd } from "../../../../../components/discovery/Breadcrumbs";
import { JsonLd } from "../../../../../components/discovery/JsonLd";
import { SalonImage } from "../../../../../components/ui/SalonImage";
import { LinkButton } from "../../../../../components/ui/Button";
import { EditorialImage } from "../../../../../components/editorial/EditorialImage";
import { PublicSalonStatus } from "../../../../../components/discovery/PublicSalonStatus";
import { ActivityTicker } from "../../../../../components/discovery/ActivityTicker";
import { SalonDetailActions } from "../../../../../components/customer-dashboard/SalonDetailActions";
import styles from "./profile.module.css";

interface SalonPageParams {
  countryCode: string;
  citySlug: string;
  salonSlug: string;
}

async function loadSalon(countryCode: string, citySlug: string, salonSlug: string) {
  return fetchDiscoveryOrNull<SalonProfileDto>(
    `${DISCOVERY_PATHS.salons}/${countryCode}/${citySlug}/${salonSlug}`,
    DISCOVERY_REVALIDATE_SECONDS,
  );
}

async function loadPublicStatus(countryCode: string, citySlug: string, salonSlug: string) {
  return fetchDiscoveryOrNull<PublicSalonStatusDto>(
    `${DISCOVERY_PATHS.salons}/${countryCode}/${citySlug}/${salonSlug}/${DISCOVERY_PATHS.status}`,
    0,
  ).catch(() => null);
}

function salonPath(salon: SalonProfileDto): string {
  return `/${salon.countryCode.toLowerCase()}/${salon.citySlug}/${salon.slug}`;
}

export async function generateMetadata({ params }: { params: Promise<SalonPageParams> }): Promise<Metadata> {
  const { countryCode, citySlug, salonSlug } = await params;
  const salon = await loadSalon(countryCode, citySlug, salonSlug);
  if (!salon) return {};

  const title = salon.name;
  const description =
    salon.description ?? `${salon.name} — services, prices, hours, and reviews. Book your chair online.`;
  const url = absoluteUrl(salonPath(salon));

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "website",
      images: salon.coverPhotoUrl ? [{ url: salon.coverPhotoUrl }] : undefined,
    },
  };
}

function buildHairSalonJsonLd(salon: SalonProfileDto) {
  return {
    "@context": "https://schema.org",
    "@type": "HairSalon",
    name: salon.name,
    url: absoluteUrl(salonPath(salon)),
    telephone: salon.phone ?? undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: salon.addressLine,
      addressLocality: salon.localitySlug ?? salon.citySlug,
      postalCode: salon.postalCode ?? undefined,
      addressCountry: salon.countryCode,
    },
    geo:
      salon.lat !== null && salon.lng !== null
        ? {
            "@type": "GeoCoordinates",
            latitude: salon.lat,
            longitude: salon.lng,
          }
        : undefined,
    openingHoursSpecification: salon.operatingHours
      .filter((h) => !h.isClosed)
      .map((h) => ({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ][h.dayOfWeek],
        opens: h.openTime,
        closes: h.closeTime,
      })),
    ...(salon.priceMin !== null && salon.priceMax !== null
      ? {
          priceRange:
            salon.priceMin === salon.priceMax
              ? formatMoney(salon.priceMin, salon.currency, salon.countryCode)
              : `${formatMoney(salon.priceMin, salon.currency, salon.countryCode)}–${formatMoney(salon.priceMax, salon.currency, salon.countryCode)}`,
        }
      : {}),
    ...(salon.ratingCount > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: salon.ratingAverage,
            reviewCount: salon.ratingCount,
          },
        }
      : {}),
  };
}

export default async function SalonPage({
  params,
  searchParams,
}: {
  params: Promise<SalonPageParams>;
  searchParams: Promise<{ style?: string }>;
}) {
  const { countryCode, citySlug, salonSlug } = await params;
  const { style } = await searchParams;
  const salon = await loadSalon(countryCode, citySlug, salonSlug);
  if (!salon) notFound();
  const publicStatus = salon.isClosedForToday
    ? null
    : await loadPublicStatus(countryCode, citySlug, salonSlug);

  const cityQuery = `city=${citySlug}&country=${salon.countryCode}`;
  const bookHref = `/book/${salon.slug}?${cityQuery}${style ? `&style=${encodeURIComponent(style)}` : ""}`;
  const cityPath = `/${salon.countryCode.toLowerCase()}/${citySlug}`;

  const [city, locality] = await Promise.all([
    fetchDiscoveryOrNull<CityDto>(
      `${DISCOVERY_PATHS.cities}/${countryCode}/${citySlug}`,
      DISCOVERY_REVALIDATE_SECONDS,
    ),
    salon.localitySlug
      ? fetchDiscoveryOrNull<LocalityDto>(
          `${DISCOVERY_PATHS.cities}/${countryCode}/${citySlug}/localities/${salon.localitySlug}`,
          DISCOVERY_REVALIDATE_SECONDS,
        )
      : Promise.resolve(null),
  ]);

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: city?.name ?? citySlug, href: cityPath },
    ...(salon.localitySlug
      ? [{ label: locality?.name ?? salon.localitySlug, href: `${cityPath}/areas/${salon.localitySlug}` }]
      : []),
    { label: salon.name, href: salonPath(salon) },
  ];

  return (
    <main className={styles.page}>
      <JsonLd data={breadcrumbJsonLd(breadcrumbItems, SITE_URL)} />
      <JsonLd data={buildHairSalonJsonLd(salon)} />

      <div className={styles.breadcrumbs}>
        <Breadcrumbs items={breadcrumbItems} />
      </div>

      <section className={styles.hero}>
        <div className={styles.cover}>
          <SalonImage
            url={salon.coverPhotoUrl}
            alt={`${salon.name} cover photo`}
            aspectRatio="16 / 10"
            rounded={0}
            priority
          />
          <ActivityTicker salonId={salon.id} />
        </div>

        <div className={styles.identity}>
          <p className={styles.eyebrow}>Barbershop in {city?.name ?? citySlug}</p>
          <h1>
            {salon.name}
            {salon.verified && (
              <span className={styles.verifiedBadge} title={VERIFICATION_BADGE_CAPTION}>
                ✓ Verified
              </span>
            )}
          </h1>
          <div className={styles.ratingLine}>
            {salon.ratingCount > 0 ? (
              <span className={styles.rating}>
                <span aria-hidden="true">★</span> {salon.ratingAverage?.toFixed(1)}
                <small>
                  {salon.ratingCount} review{salon.ratingCount === 1 ? "" : "s"}
                </small>
              </span>
            ) : (
              <span className={styles.newShop}>New on FastQue</span>
            )}
          </div>
          <address>{salon.addressLine}</address>
          <SalonDetailActions salon={{ id: salon.id, name: salon.name, slug: salon.slug, citySlug: salon.citySlug, countryCode: salon.countryCode }} />
          {salon.phone && <a className={styles.phone} href={`tel:${salon.phone}`}>{salon.phone}</a>}
          {salon.description && <p className={styles.description}>{salon.description}</p>}

          {salon.isClosedForToday && (
            <p className={styles.closedToday} role="status">
              {SHOP_CLOSED_TODAY_MESSAGE}
            </p>
          )}

          {!salon.isClosedForToday && (
            <>
              <div className={styles.actions}>
                <LinkButton href={bookHref} variant="primary" className={styles.action}>
                  Book an appointment
                </LinkButton>
                <LinkButton
                  href={`/queue/${salon.slug}?${cityQuery}`}
                  variant="outline"
                  className={styles.action}
                >
                  Join live queue
                </LinkButton>
              </div>
              <p className={styles.assurance}>Availability and queue details are confirmed in the next step.</p>
            </>
          )}
        </div>
      </section>

      {publicStatus && <PublicSalonStatus status={publicStatus} />}

      <div className={styles.contentGrid}>
        <div className={styles.mainColumn}>
          <section className={styles.sectionCard}>
            <div className={styles.sectionHeading}>
              <p className={styles.eyebrow}>Inside the shop</p>
              <h2>Photos</h2>
            </div>
            <PhotoGallery photos={salon.photos} salonName={salon.name} />
          </section>

          <section className={styles.sectionCard}>
            <div className={`${styles.sectionHeading} ${styles.sectionHeadingWithArt}`}>
              <div>
                <p className={styles.eyebrow}>Choose your cut</p>
                <h2>Services & pricing</h2>
              </div>
              <span className={styles.sectionArt} aria-hidden="true">
                <EditorialImage id="barber-equipment-tools" width={72} height={54} />
              </span>
            </div>
            <ServiceList
              services={salon.services}
              currency={salon.currency}
              countryCode={salon.countryCode}
              onlineBookingDiscountPercent={salon.onlineBookingDiscountPercent ?? 0}
            />
          </section>

          {salon.team.length > 0 && (
            <section className={styles.sectionCard}>
              <div className={styles.sectionHeading}>
                <p className={styles.eyebrow}>Who&apos;s working</p>
                <h2>Meet the team</h2>
              </div>
              <TeamSection team={salon.team} />
            </section>
          )}

          <section className={styles.sectionCard}>
            <div className={styles.sectionHeading}>
              <p className={styles.eyebrow}>Customer experiences</p>
              <h2>Reviews</h2>
            </div>
            <ReviewList reviews={salon.reviews} />
          </section>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.hoursCard}>
            <div className={styles.sectionHeading}>
              <p className={styles.eyebrow}>Plan your visit</p>
              <h2>Opening hours</h2>
            </div>
            <OperatingHoursTable hours={salon.operatingHours} />
          </section>
          <div className={styles.queueNote}>
            <strong>Prefer to join the Live Queue?</strong>
            <p>Check the live queue path to see whether this shop is currently accepting joins.</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
