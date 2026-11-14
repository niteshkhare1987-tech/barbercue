import Link from "next/link";
import type { SalonListItemDto } from "@barbercue/shared";
import { formatDistance, formatMoney, SALON_TYPE_LABELS, SHOP_CLOSED_TODAY_MESSAGE, VERIFICATION_BADGE_CAPTION } from "@barbercue/shared";
import { SalonImage } from "../ui/SalonImage";
import { FavoriteButton } from "./FavoriteButton";
import { ShareSalonButton } from "../customer-dashboard/ShareSalonButton";
import styles from "./salon-card.module.css";

export function SalonCard({ salon, styleName }: { salon: SalonListItemDto; styleName?: string }) {
  const countryCode = salon.countryCode.toLowerCase();
  const profileParams = styleName ? `?style=${encodeURIComponent(styleName)}` : "";
  const actionParams = new URLSearchParams({
    city: salon.citySlug,
    country: salon.countryCode,
  });
  if (styleName) actionParams.set("style", styleName);

  const profileHref = `/${countryCode}/${salon.citySlug}/${salon.slug}${profileParams}`;
  const bookingHref = `/book/${salon.slug}?${actionParams.toString()}`;
  const queueHref = `/queue/${salon.slug}?${actionParams.toString()}`;

  return (
    <article className={styles.card}>
      <div className={styles.media}>
        <Link href={profileHref} className={styles.imageLink} aria-label={`View ${salon.name}`}>
          <SalonImage
            url={salon.coverPhotoUrl}
            alt={`${salon.name} barbershop`}
            aspectRatio="4 / 3"
            rounded={0}
          />
        </Link>
        <FavoriteButton salonId={salon.id} salonName={salon.name} />
        <ShareSalonButton salon={salon} />
      </div>

      <div className={styles.body}>
        <div className={styles.titleRow}>
          <div>
            <Link href={profileHref} className={styles.nameLink}>
              <h3 className={styles.name}>
                {salon.name}
                {salon.verified && (
                  <span
                    title={VERIFICATION_BADGE_CAPTION}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      marginLeft: 8,
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      letterSpacing: "0.02em",
                      color: "var(--bc-success)",
                      background: "color-mix(in srgb, var(--bc-success) 12%, transparent)",
                      verticalAlign: "middle",
                    }}
                  >
                    ✓ Verified
                  </span>
                )}
              </h3>
            </Link>
            <p className={styles.address}>{salon.addressLine}</p>
            {salon.salonType && (
              <span className={salon.salonTypeConfirmed ? styles.typeChip : styles.typeChipUnset}>
                {salon.salonTypeConfirmed ? SALON_TYPE_LABELS[salon.salonType] : "Type not set"}
              </span>
            )}
          </div>
          {salon.ratingAverage !== null && (
            <span className={styles.rating} aria-label={`${salon.ratingAverage.toFixed(1)} out of 5`}>
              <span aria-hidden="true">★</span> {salon.ratingAverage.toFixed(1)}
            </span>
          )}
        </div>

        <div className={styles.metaRow}>
          <span>
            {salon.ratingAverage === null
              ? "New on FastQue"
              : `${salon.ratingCount} ${salon.ratingCount === 1 ? "review" : "reviews"}`}
          </span>
          {/* With a service selected, show THAT service's price at this salon (never "from"). */}
          {salon.selectedService ? (
            <strong title={`${salon.selectedService.name} · ${salon.selectedService.durationMinutes} min`}>
              {salon.selectedService.name} {formatMoney(salon.selectedService.price, salon.currency, salon.countryCode)}
            </strong>
          ) : (
            salon.priceMin !== null && (
              <strong>
                From {formatMoney(salon.priceMin, salon.currency, salon.countryCode)}
              </strong>
            )
          )}
        </div>

        {salon.isClosedForToday && (
          <p className={styles.closedToday} role="status">
            {SHOP_CLOSED_TODAY_MESSAGE}
          </p>
        )}

        {(salon.isOpenNow !== null || salon.distanceKm !== null || salon.waitingCount > 0) && (
          <div className={styles.statusRow}>
            {salon.isOpenNow !== null && (
              <span className={salon.isOpenNow ? styles.openBadge : styles.closedBadge}>
                {salon.isOpenNow ? "Open now" : "Closed now"}
              </span>
            )}
            {salon.distanceKm !== null && (
              <span className={styles.distanceText}>{formatDistance(salon.distanceKm, salon.countryCode)} away</span>
            )}
            {/* Real live signal (Issue #13 Mission F) — only shown when genuinely > 0, never a
                fabricated "0 waiting" placeholder. */}
            {salon.waitingCount > 0 && (
              <span className={styles.distanceText}>
                {salon.waitingCount} {salon.waitingCount === 1 ? "person" : "people"} waiting
              </span>
            )}
          </div>
        )}

        {!salon.isClosedForToday && (
          <div className={styles.actions}>
            <Link href={bookingHref} className={styles.primaryAction}>
              Book
            </Link>
            <Link href={queueHref} className={styles.secondaryAction}>
              Join queue
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}
