"use client";

import Link from "next/link";
import type { SalonListItemDto } from "@barbercue/shared";
import { SHOP_CLOSED_TODAY_MESSAGE, formatDistance, formatMoney } from "@barbercue/shared";
import { FavoriteButton } from "../discovery/FavoriteButton";
import { SalonImage } from "../ui/SalonImage";
import { ShareSalonButton } from "./ShareSalonButton";
import styles from "./map-preview.module.css";

/** Compact salon card shown over the map for the selected pin. Every value is from the search API. */
export function MapPreviewCard({ salon }: { salon: SalonListItemDto }) {
  const country = salon.countryCode.toLowerCase();
  const query = new URLSearchParams({ city: salon.citySlug, country: salon.countryCode }).toString();
  const profileHref = `/${country}/${salon.citySlug}/${salon.slug}`;
  const price = salon.selectedService?.price ?? salon.priceMin;
  return (
    <article className={styles.card}>
      <Link href={profileHref} className={styles.photo} tabIndex={-1} aria-hidden="true">
        <SalonImage url={salon.coverPhotoUrl} alt="" aspectRatio="1 / 1" rounded={12} />
      </Link>
      <div className={styles.body}>
        <h3 className={styles.name}>
          <Link href={profileHref}>{salon.name}</Link>
          {salon.verified && <span className={styles.verified} title="Verified listing">✓</span>}
        </h3>
        <p className={styles.meta}>
          {salon.ratingAverage !== null ? (
            <>
              <span className={styles.star} aria-hidden="true">★</span> {salon.ratingAverage.toFixed(1)} ({salon.ratingCount})
            </>
          ) : (
            "New on FastQue"
          )}
          {salon.distanceKm !== null && <> · {formatDistance(salon.distanceKm, salon.countryCode)} away</>}
        </p>
        <p className={styles.address}>{salon.addressLine}</p>
        {price !== null && price !== undefined && (
          <p className={styles.price}>
            {salon.selectedService ? salon.selectedService.name : "From"} {formatMoney(price, salon.currency, salon.countryCode)}
          </p>
        )}
        {salon.queueWait && salon.isOpenNow && (
          <p className={styles.queue}>
            Live queue: {salon.queueWait.waitingCount} waiting · ~{salon.queueWait.estimatedWaitMinutes} min
          </p>
        )}
        <div className={styles.actions}>
          <FavoriteButton salonId={salon.id} salonName={salon.name} variant="inline" />
          <ShareSalonButton salon={salon} variant="inline" />
          {salon.isClosedForToday ? (
            <span className={styles.closed}>{SHOP_CLOSED_TODAY_MESSAGE}</span>
          ) : (
            <>
              <Link href={`/queue/${salon.slug}?${query}`} className={styles.secondary}>Join Queue</Link>
              <Link href={`/book/${salon.slug}?${query}`} className={styles.primary}>Book Now</Link>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
