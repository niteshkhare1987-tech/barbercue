"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { SalonListItemDto, SalonOfferSummaryDto } from "@barbercue/shared";
import { SALON_TYPE_LABELS, SHOP_CLOSED_TODAY_MESSAGE, VERIFICATION_BADGE_CAPTION, formatDistance, formatMoney } from "@barbercue/shared";
import { SalonImage } from "../ui/SalonImage";
import { FavoriteButton } from "./FavoriteButton";
import { ShareSalonButton } from "../customer-dashboard/ShareSalonButton";
import { Lightbox } from "./PhotoGallery";
import styles from "./salon-result-card.module.css";

// Booking page 3.0: the horizontal marketplace card on /search. Every value here comes from the
// search API (real services, prices, reviews, hours and published offers). A discounted price is
// shown only when the server says the offer is certain for anyone; the booking flow recalculates
// and revalidates the offer on the server before anything is confirmed.

const AUDIENCE_TEXT: Record<SalonOfferSummaryDto["audience"], string | null> = {
  ALL: null,
  NEW: "First visit only",
  REPEAT: "Returning customers",
  INACTIVE: "Welcome-back customers",
};

export function offerBadgeText(offer: SalonOfferSummaryDto, currency: string | null, countryCode: string): string {
  return offer.discountType === "PERCENT"
    ? `${offer.discountValue}% OFF`
    : `Flat ${formatMoney(offer.discountValue, currency, countryCode)} OFF`;
}

/**
 * Headline for all of a salon's offers together: "Up to 30% OFF" (the largest percentage), or —
 * when there are only flat-amount offers — "Up to ₹100 OFF" (the largest rupee saving). A salon
 * with a single offer shows that offer's own text.
 */
export function offerHeadlineText(salon: SalonListItemDto): string | null {
  const offer = salon.offers?.[0];
  const headline = salon.offerHeadline;
  if (!offer) return null;
  if (!headline || headline.count <= 1) return offerBadgeText(offer, salon.currency, salon.countryCode);
  return headline.maxPercent !== null
    ? `Up to ${headline.maxPercent}% OFF`
    : `Up to ${formatMoney(headline.maxSaving, salon.currency, salon.countryCode)} OFF`;
}

/** Plain-language conditions ("First visit only · Mon–Fri, 14:00–17:00 · On bookings above ₹500"). */
export function offerConditions(offer: SalonOfferSummaryDto, currency: string | null, countryCode: string): string[] {
  return [
    AUDIENCE_TEXT[offer.audience],
    offer.schedule,
    offer.minimumBookingAmount !== null ? `On bookings above ${formatMoney(offer.minimumBookingAmount, currency, countryCode)}` : null,
    offer.maximumDiscountAmount !== null ? `Up to ${formatMoney(offer.maximumDiscountAmount, currency, countryCode)} off` : null,
  ].filter((text): text is string => !!text);
}

function validTill(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(iso));
}

/** "22:00" → "10:00 PM". */
export function clockText(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** Live-queue ETA for the Join Queue button: "No wait" or "~25 min wait", plus how many are waiting. */
export function queueEtaText(wait: NonNullable<SalonListItemDto["queueWait"]>): { eta: string; waiting: string } {
  return {
    eta: wait.estimatedWaitMinutes === 0 ? "No wait" : `~${wait.estimatedWaitMinutes} min wait`,
    waiting: wait.waitingCount === 0 ? "No one in queue" : `${wait.waitingCount} in queue`,
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Opens 10:00 AM" / "Opens tomorrow 10:00 AM" / "Opens Mon 10:00 AM". */
function opensText(next: NonNullable<SalonListItemDto["opensNext"]>): string {
  const day = next.inDays === 0 ? "" : next.inDays === 1 ? "tomorrow " : `${WEEKDAYS[next.dayOfWeek]} `;
  return `Opens ${day}${clockText(next.time)}`;
}

/**
 * Status for a salon card: open → "Open now" (green) with only the closing time; closed → "Closed"
 * with only when it next opens. `text` joins both for compact places (the Compare table).
 */
export function salonStatus(salon: SalonListItemDto): { tone: "open" | "closed" | "unknown"; label: string; detail: string | null; text: string } {
  const make = (tone: "open" | "closed" | "unknown", label: string, detail: string | null) => ({ tone, label, detail, text: detail ? `${label} · ${detail}` : label });
  const opens = salon.opensNext ? opensText(salon.opensNext) : null;
  if (salon.isClosedForToday) return make("closed", SHOP_CLOSED_TODAY_MESSAGE, opens);
  if (salon.isOpenNow === true) {
    const closes = salon.closesAt ?? salon.todayHours?.closeTime;
    return make("open", "Open now", closes ? `Closes ${clockText(closes)}` : null);
  }
  if (salon.isOpenNow === false) return make("closed", "Closed", opens);
  return make("unknown", "Hours not listed", null);
}

function OffersDialog({ salon, onClose }: { salon: SalonListItemDto; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <div className={styles.dialogBackdrop} onClick={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <div className={styles.dialogHead}>
          <h3 id={titleId}>Offers at {salon.name}</h3>
          <button ref={closeRef} type="button" className={styles.dialogClose} onClick={onClose} aria-label="Close offers">×</button>
        </div>
        <ul className={styles.dialogList}>
          {(salon.offers ?? []).map((offer) => (
            <li key={offer.id}>
              <strong>{offerBadgeText(offer, salon.currency, salon.countryCode)}</strong> {offer.title}
              <p>{offer.appliesTo ? `On ${offer.appliesTo}` : "On all services"} · Valid till {validTill(offer.validTo)}</p>
              {offer.description && <p>{offer.description}</p>}
              {offerConditions(offer, salon.currency, salon.countryCode).length > 0 && (
                <p className={styles.terms}>{offerConditions(offer, salon.currency, salon.countryCode).join(" · ")}</p>
              )}
            </li>
          ))}
        </ul>
        <p className={styles.dialogNote}>The final price is confirmed when you book; eligibility is checked then.</p>
      </div>
    </div>
  );
}

export function SalonResultCard({ salon, styleName }: { salon: SalonListItemDto; styleName?: string }) {
  const [photo, setPhoto] = useState(0);
  const [offersOpen, setOffersOpen] = useState(false);
  // Gallery viewer (the same one as the salon profile page), opened from a thumbnail.
  const [viewing, setViewing] = useState<number | null>(null);
  const [failedPhotos, setFailedPhotos] = useState<Set<number>>(new Set());
  const openerRef = useRef<HTMLElement | null>(null);
  const markFailed = useCallback((index: number) => setFailedPhotos((prev) => new Set(prev).add(index)), []);
  const openViewer = (index: number, opener: HTMLElement) => {
    openerRef.current = opener;
    setViewing(index);
  };
  const country = salon.countryCode.toLowerCase();
  const money = (amount: number) => formatMoney(amount, salon.currency, salon.countryCode);
  const photos = salon.photoUrls?.length ? salon.photoUrls : salon.coverPhotoUrl ? [salon.coverPhotoUrl] : [];
  const offer = salon.offers?.[0] ?? null;
  const offerCount = salon.offerHeadline?.count ?? salon.offers?.length ?? 0;
  const moreOffers = offerCount - 1;
  const headline = offerHeadlineText(salon);
  // Each listed service's own best discount every customer gets.
  const serviceOffer = (serviceId: string) => salon.serviceOffers?.find((o) => o.serviceId === serviceId) ?? null;

  const profileHref = `/${country}/${salon.citySlug}/${salon.slug}${styleName ? `?style=${encodeURIComponent(styleName)}` : ""}`;
  const bookingParams = new URLSearchParams({ city: salon.citySlug, country: salon.countryCode });
  if (styleName) bookingParams.set("style", styleName);
  // The card's offer travels into the existing booking journey, which re-checks it on the server.
  // The best guaranteed offer for the selected service, otherwise the card's top offer.
  const bookingOffer = (salon.selectedService && serviceOffer(salon.selectedService.id)?.offerId) ?? offer?.id;
  if (bookingOffer) bookingParams.set("offer", bookingOffer);
  const bookingHref = `/book/${salon.slug}?${bookingParams.toString()}`;
  const queueParams = new URLSearchParams({ city: salon.citySlug, country: salon.countryCode });
  if (styleName) queueParams.set("style", styleName);
  const queueHref = `/queue/${salon.slug}?${queueParams.toString()}`;
  const eta = salon.queueWait ? queueEtaText(salon.queueWait) : null;

  const rows = [
    ...(salon.selectedService ? [{ ...salon.selectedService, selected: true }] : []),
    ...(salon.otherServices ?? []).map((service) => ({ ...service, selected: false })),
  ].slice(0, 4);
  const hiddenServices = Math.max(0, (salon.serviceCount ?? 0) - rows.length);

  const status = salonStatus(salon);

  return (
    <article className={styles.card} aria-labelledby={`salon-${salon.id}`}>
      <div className={styles.media}>
        {photos.length > 0 ? (
          <button
            type="button"
            className={styles.mediaLink}
            onClick={(event) => openViewer(photo, event.currentTarget)}
            aria-label={`View ${salon.name} photos (${photos.length})`}
          >
            <SalonImage url={photos[photo]} alt={`${salon.name} salon`} aspectRatio="4 / 3" rounded={0} />
          </button>
        ) : (
          <Link href={profileHref} className={styles.mediaLink} aria-label={`View ${salon.name}`} tabIndex={-1}>
            <SalonImage url={null} alt={`${salon.name} salon`} aspectRatio="4 / 3" rounded={0} />
          </Link>
        )}
        <FavoriteButton salonId={salon.id} salonName={salon.name} />
        <ShareSalonButton salon={salon} />
        {headline && <span className={styles.offerBadge}>{headline}</span>}
        {photos.length > 1 && (
          <>
            <button type="button" className={`${styles.arrow} ${styles.arrowPrev}`} aria-label="Previous photo" onClick={() => setPhoto((p) => (p - 1 + photos.length) % photos.length)}>‹</button>
            <button type="button" className={`${styles.arrow} ${styles.arrowNext}`} aria-label="Next photo" onClick={() => setPhoto((p) => (p + 1) % photos.length)}>›</button>
            <span className={styles.counter} aria-live="polite">{photo + 1}/{photos.length}</span>
          </>
        )}
      </div>

      <div className={styles.info}>
        <div className={styles.titleRow}>
          <h3 id={`salon-${salon.id}`} className={styles.name}>
            <Link href={profileHref}>{salon.name}</Link>
          </h3>
          {salon.ratingAverage !== null && (
            <span className={styles.rating} aria-label={`Rated ${salon.ratingAverage.toFixed(1)} from ${salon.ratingCount} reviews`}>
              ★ {salon.ratingAverage.toFixed(1)} <small>({salon.ratingCount})</small>
            </span>
          )}
          {salon.verified && <span className={styles.verified} title={VERIFICATION_BADGE_CAPTION}>✓ Verified</span>}
        </div>
        <p className={styles.address}>{salon.addressLine}</p>
        {salon.distanceKm !== null && <p className={styles.distance}>{formatDistance(salon.distanceKm, salon.countryCode)} away</p>}
        <div className={styles.chips}>
          {salon.salonType && salon.salonTypeConfirmed ? (
            <span className={styles.typeChip}>{SALON_TYPE_LABELS[salon.salonType]}</span>
          ) : (
            <span className={`${styles.typeChip} ${styles.typeUnknown}`}>Type not set</span>
          )}
          {salon.ratingAverage === null && <span className={`${styles.typeChip} ${styles.typeUnknown}`}>No reviews yet</span>}
          {salon.waitingCount > 0 && <span className={styles.typeChip}>{salon.waitingCount} waiting</span>}
        </div>
        {photos.length > 1 && (
          <div className={styles.thumbs}>
            {photos.slice(1, 4).map((url, index) => (
              <button
                key={url}
                type="button"
                className={styles.thumb}
                onClick={(event) => openViewer(index + 1, event.currentTarget)}
                aria-label={`View photo ${index + 2} of ${photos.length}`}
              >
                <SalonImage url={url} alt="" aspectRatio="4 / 3" rounded={6} />
              </button>
            ))}
            {photos.length > 4 && (
              <button type="button" className={styles.thumbMore} onClick={(event) => openViewer(4, event.currentTarget)} aria-label={`View all ${photos.length} photos`}>
                +{photos.length - 4}
              </button>
            )}
          </div>
        )}
        <p className={`${styles.status} ${styles[status.tone]}`}>
          <span className={styles.statusLabel}>{status.label}</span>
          {status.detail && <span className={styles.statusDetail}> · {status.detail}</span>}
        </p>
      </div>

      {offer && (
        <button
          type="button"
          className={styles.offer}
          onClick={() => setOffersOpen(true)}
          aria-label={moreOffers > 0 ? `${offerCount} offers, ${headline}. See all offers` : `${offer.title}: ${headline}. See offer details`}
        >
          <span className={styles.offerIcon} aria-hidden="true">%</span>
          {moreOffers > 0 && salon.offerHeadline ? (
            <span className={styles.offerBody}>
              <span className={styles.offerTitle}>{offerCount} offers at this salon</span>
              <span className={styles.offerValue}>
                <span className={styles.offerHighlight}>{headline}</span>
              </span>
              <span className={styles.offerTerms}>
                Save up to {formatMoney(salon.offerHeadline.maxSaving, salon.currency, salon.countryCode)} on a service
              </span>
              <span className={styles.offerValid}>Best: {offer.title}</span>
              <span className={styles.offerMore}>See all {offerCount} offers</span>
            </span>
          ) : (
            <span className={styles.offerBody}>
              <span className={styles.offerTitle}>{offer.title}</span>
              <span className={styles.offerValue}>
                <span className={styles.offerHighlight}>{headline}</span>{" "}
                {offer.appliesTo ? `on ${offer.appliesTo}` : "on all services"}
              </span>
              {offerConditions(offer, salon.currency, salon.countryCode).length > 0 && (
                <span className={styles.offerTerms}>{offerConditions(offer, salon.currency, salon.countryCode).join(" · ")}</span>
              )}
              <span className={styles.offerValid}>Valid till {validTill(offer.validTo)}</span>
            </span>
          )}
          <span className={styles.offerChevron} aria-hidden="true">›</span>
        </button>
      )}

      <div className={styles.prices}>
        {rows.length === 0 ? (
          <p className={styles.muted}>Prices on request</p>
        ) : (
          <ul>
            {rows.map((row) => {
              const best = serviceOffer(row.id);
              const discounted = best
                ? { originalPrice: row.price, offerPrice: best.offerPrice }
                : offer?.price && offer.price.serviceId === row.id
                  ? offer.price
                  : null;
              return (
                <li key={row.id} className={row.selected ? styles.selectedRow : undefined}>
                  <span className={styles.serviceName}>{row.name}</span>
                  <span className={styles.servicePrice}>
                    {discounted ? (
                      <>
                        <s>{money(discounted.originalPrice)}</s> <strong>{money(discounted.offerPrice)}</strong>
                      </>
                    ) : (
                      <strong>{money(row.price)}</strong>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {salon.selectedService === null && <p className={styles.muted}>Doesn’t list this service</p>}
        {offer?.conditional && offer.appliesTo && <p className={styles.conditional}>Offer may apply at booking</p>}
        <Link href={profileHref} className={styles.allServices}>
          View all services{hiddenServices > 0 ? ` (${hiddenServices} more)` : ""} →
        </Link>
      </div>

      <div className={styles.actions}>
        {salon.isClosedForToday ? (
          <span className={styles.muted}>Closed today</span>
        ) : (
          <>
            <Link href={bookingHref} className={styles.book}>Book Now</Link>
            {salon.isOpenNow === false ? (
              <span className={styles.queueClosed} title="The live queue opens when the salon opens">Queue closed</span>
            ) : (
              <Link
                href={queueHref}
                className={styles.queue}
                aria-label={eta ? `Join the live queue — ${eta.eta}, ${eta.waiting}` : "Join the live queue"}
              >
                <span>Join Queue</span>
                {eta && <small className={styles.eta}>{eta.eta}</small>}
              </Link>
            )}
          </>
        )}
        <Link href={profileHref} className={styles.profile}>View Profile</Link>
      </div>

      {offersOpen && <OffersDialog salon={salon} onClose={() => setOffersOpen(false)} />}
      {viewing !== null && (
        <Lightbox
          photos={photos.map((url) => ({ url, altText: null }))}
          salonName={salon.name}
          openIndex={viewing}
          setOpenIndex={setViewing}
          failedIndices={failedPhotos}
          markFailed={markFailed}
          openerRef={openerRef}
        />
      )}
    </article>
  );
}
