"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BOOKING_PATHS,
  CREDITS_PATHS,
  DISCOVERY_PATHS,
  SALON_BOOKING_INFO_PATHS,
  computeMaxRedeemableCredits,
  computePercentageDiscountPaise,
  numberToPaise,
  paiseToRupees,
  summarizeServiceNames,
  type AvailabilitySlotDto,
  type BookingDetailDto,
  type BookingPaymentInfoDto,
  type CancellationPolicyDto,
  type CancelBookingResponseDto,
  type CustomerCreditBalanceDto,
  type OperatingHoursDto,
  type PublicOfferDto,
  type ServiceDto,
  type StaffOptionDto,
  formatBookingArrivalTime,
  formatMoney,
  formatZonedDateTime,
} from "@barbercue/shared";
import {
  appliesToServices,
  customerOfferErrorText,
  estimateFor,
  isOfferError,
  lookupPublicOffer,
  offerDiscountText,
  validUntilText,
} from "../../lib/public-offers";
import { apiFetch, ApiError } from "../../lib/api";
import { newIdempotencyKey } from "../../lib/idempotency";
import { useAuth } from "../../lib/auth-context";
import { Button } from "../ui/Button";
import { GoogleIdentityButton } from "../auth/GoogleIdentityButton";
import { ServiceStep } from "./ServiceStep";
import { StaffStep } from "./StaffStep";
import { DateStep } from "./DateStep";
import { SlotStep } from "./SlotStep";
import { CancelBookingDialog } from "./CancelBookingDialog";
import { RescheduleBookingDialog } from "./RescheduleBookingDialog";
import { BookingActionsBar } from "./BookingActionsBar";
import { BookingUpiAction } from "./BookingUpiAction";
import { hasCustomerBookingSession } from "./booking-session";
import { forgetCampaign, recallCampaign, sessionTokenStore } from "../../lib/campaign-token";
import { CheckInPanel, canCheckIn } from "../queue/CheckInPanel";
import styles from "./booking.module.css";

// Part O (Customer Dues + Cancellation Policy mission): "Free cancellation up to 1 hour before
// your appointment" — but only ever the real effective window, never a hard-coded "1 hour" when a
// salon's own policy is more generous. 60/120/etc render as whole hours; anything else falls back
// to a plain minute count rather than an awkward "1 hour 30 minutes".
function discountedPrice(price: number, percent: number): number {
  const originalPaise = numberToPaise(price);
  return paiseToRupees(
    originalPaise - computePercentageDiscountPaise(originalPaise, percent),
  );
}

function formatFreeCancellationWindow(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minutes`;
}

export function BookingFlow({
  salonId,
  services,
  operatingHours,
  selectedStyleName,
  currency,
  countryCode,
  salonTimezone,
  onlineBookingDiscountPercent = 0,
  initialServiceIds,
  initialStaffId,
  campaignKey,
  offerId,
  offerCity,
}: {
  salonId: string;
  services: ServiceDto[];
  operatingHours: OperatingHoursDto[];
  // From the salon this flow belongs to — every amount shown here is in its currency.
  currency: string | null;
  countryCode?: string | null;
  // Pre-confirmation timezone fix — SalonProfileDto's resolved IANA zone (server-side, via
  // resolveSalonTimeZone). Every pre-confirm date/slot render in this flow uses this, never the
  // customer device's zone, so the displayed appointment time never silently jumps once the
  // booking actually confirms (BookingDetailDto.salonTimezone is the exact same resolution).
  salonTimezone: string | null;
  // Current shop-funded APP/WEB offer. Preview only; the backend snapshots and enforces the
  // authoritative discount at booking creation.
  onlineBookingDiscountPercent?: number;
  // AI Style Advisor hand-off (major-upgrade phase) — set only when this flow was reached via
  // "Try This Look"; threaded straight into the booking-creation body when present.
  selectedStyleName?: string;
  // "Book again" hand-off (Phase 3, customer convenience) — preselects the previous appointment's
  // FULL service selection and barber, same idea as selectedStyleName's Style Advisor hand-off.
  // The customer still explicitly picks a new date and slot below; nothing here assumes the old
  // slot is available. Multi-service booking core mission: carries every previously-selected
  // service, not just the first — see apps/web/lib/booking-actions.ts's rebookUrl.
  initialServiceIds?: string[];
  initialStaffId?: string | null;
  // Identifies this shop for a campaign code remembered from a shared link (lib/campaign-token.ts). When a valid, unexpired
  // code exists for this shop it is sent as the optional `attributionToken`; the server alone decides whether it counts.
  campaignKey?: string;
  // An offer chosen on the public Offers page (?offer=). It is read with GET offers/:offerId and, when it belongs to this shop, sent
  // as `offerId`. The server alone decides eligibility and the price. `offerCity` (the link's city slug) is used only to find the
  // offer on a server that has no lookup by id.
  offerId?: string;
  offerCity?: string;
}) {
  const { status: authStatus, user, googleLogin } = useAuth();
  const isCustomerSession = hasCustomerBookingSession(authStatus, user);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>(initialServiceIds ?? []);
  const [offer, setOffer] = useState<PublicOfferDto | null>(null);
  const [offerChecked, setOfferChecked] = useState(false);
  const [offerDropped, setOfferDropped] = useState(false);
  const [offerRefused, setOfferRefused] = useState(false);
  const activeOffer = offer && !offerDropped ? offer : null;

  useEffect(() => {
    if (!offerId) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      // No offer is applied when it cannot be read; the booking itself is unaffected.
      const found = await lookupPublicOffer(
        (id) => apiFetch<PublicOfferDto>(`offers/${encodeURIComponent(id)}`),
        offerCity
          ? (cursor) => apiFetch<{ items: PublicOfferDto[]; nextCursor: string | null }>(`offers?${new URLSearchParams({ city: offerCity, limit: "50", ...(cursor ? { cursor } : {}) }).toString()}`)
          : null,
        offerId,
      );
      if (cancelled) return;
      // The offer must belong to the shop being booked: another shop's offer is never shown or sent.
      setOffer(found && found.salon.id === salonId ? found : null);
      setOfferChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, [offerId, offerCity, salonId]);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null | undefined>(initialStaffId);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlotDto | null>(null);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  const [staffOptions, setStaffOptions] = useState<StaffOptionDto[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [slots, setSlots] = useState<AvailabilitySlotDto[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmedBooking, setConfirmedBooking] = useState<BookingDetailDto | null>(null);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  // Only the charge-amount/ledger fields are read off this — the booking itself always comes from
  // confirmedBooking (updated in place by both onCancelled and onRescheduled below) so the two
  // actions can never race each other for which one's "latest" booking gets displayed.
  const [cancelResult, setCancelResult] = useState<CancelBookingResponseDto | null>(null);
  const [showRescheduleDialog, setShowRescheduleDialog] = useState(false);
  const [cancellationPolicy, setCancellationPolicy] = useState<CancellationPolicyDto | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<BookingPaymentInfoDto | null>(null);
  const [paymentInfoError, setPaymentInfoError] = useState(false);

  // FastQue Credits / Wallet V1 — the customer's live wallet balance, fetched once they're signed
  // in and reach the Confirm step (never before: an anonymous visitor has no balance to show).
  // creditsToRedeem is a plain number input, re-clamped to [0, min(balance, price)] on every
  // change so the displayed payable amount is always consistent with what the server will actually
  // accept — the server re-validates this again regardless (see BookingsService.create), this is
  // only for a sane, honest preview.
  const [creditsBalance, setCreditsBalance] = useState<number | null>(null);
  const [creditsToRedeem, setCreditsToRedeem] = useState(0);

  // Part O — fetched once per salon, shown alongside the Confirm step so the customer knows the
  // real policy before they book, not just at cancel time (CancelBookingDialog fetches it again
  // itself for the live charge preview, deliberately not shared state — see that component).
  useEffect(() => {
    let cancelled = false;
    apiFetch<CancellationPolicyDto>(
      `${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.cancellationPolicy}`,
    )
      .then((policy) => {
        if (!cancelled) setCancellationPolicy(policy);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [salonId]);

  useEffect(() => {
    let cancelled = false;
    setPaymentInfoError(false);
    apiFetch<BookingPaymentInfoDto>(`${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.paymentInfo}`)
      .then((info) => { if (!cancelled) setPaymentInfo(info); })
      .catch(() => { if (!cancelled) setPaymentInfoError(true); });
    return () => { cancelled = true; };
  }, [salonId]);

  // Credits are customer-only, exactly like booking creation itself. A STAFF/ADMIN audience can be
  // authenticated yet still be forbidden by the customer credits endpoint, so do not send that
  // guaranteed-403 request just because authStatus says "authenticated".
  useEffect(() => {
    if (!isCustomerSession) {
      setCreditsBalance(null);
      setCreditsToRedeem(0);
      return;
    }
    let cancelled = false;
    apiFetch<CustomerCreditBalanceDto>(`${CREDITS_PATHS.credits}/${CREDITS_PATHS.balance}`)
      .then((result) => {
        if (!cancelled) setCreditsBalance(result.balance);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isCustomerSession]);

  // Stable across retries of the exact same attempt (same services/staff/date/slot); regenerates
  // the moment any earlier choice changes, since that's a materially different attempt. The deps
  // are deliberately not read inside the memo callback — they're a recompute trigger only.
  const idempotencyKey = useMemo(
    () => newIdempotencyKey(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedServiceIds.join(","), selectedStaffId, selectedDate, selectedSlot?.slotStart, activeOffer?.id],
  );

  // Multi-service booking core mission — toggling any service is a materially different selection:
  // combined duration/price change immediately (ServiceStep derives those from the array itself,
  // no extra state here), staff qualification must be re-fetched, and any previously chosen
  // date/slot can no longer be trusted (a slot valid for the old selection may not fit the new
  // combined duration) — see the effects below, which react to selectedServiceIds changing.
  function toggleService(id: string) {
    setSelectedServiceIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
    );
    setSelectedStaffId(undefined);
    setSelectedDate(null);
    setSelectedSlot(null);
    setSlots([]);
  }

  function handleSelectStaff(id: string | null) {
    setSelectedStaffId(id);
    setSelectedDate(null);
    setSelectedSlot(null);
    setSlots([]);
  }

  function handleSelectDate(date: string) {
    setSelectedDate(date);
    setSelectedSlot(null);
  }

  useEffect(() => {
    if (selectedServiceIds.length === 0) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setStaffLoading(true);
        return apiFetch<StaffOptionDto[]>(
          `${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.staff}?serviceIds=${selectedServiceIds.join(",")}`,
        );
      })
      .then((options) => {
        if (!cancelled && options) setStaffOptions(options);
      })
      .catch(() => {
        if (!cancelled) setStaffOptions([]);
      })
      .finally(() => {
        if (!cancelled) setStaffLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServiceIds.join(","), salonId]);

  useEffect(() => {
    if (selectedServiceIds.length === 0 || !selectedDate || selectedStaffId === undefined) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setSlotsLoading(true);
        const params = new URLSearchParams({ serviceIds: selectedServiceIds.join(","), date: selectedDate });
        if (selectedStaffId) params.set("staffId", selectedStaffId);
        return apiFetch<AvailabilitySlotDto[]>(
          `${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.availability}?${params.toString()}`,
        );
      })
      .then((result) => {
        if (!cancelled && result) setSlots(result);
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServiceIds.join(","), selectedDate, selectedStaffId, salonId]);

  async function refreshCurrentAvailability() {
    if (selectedServiceIds.length === 0 || !selectedDate) return;
    const params = new URLSearchParams({ serviceIds: selectedServiceIds.join(","), date: selectedDate });
    if (selectedStaffId) params.set("staffId", selectedStaffId);
    const result = await apiFetch<AvailabilitySlotDto[]>(
      `${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.availability}?${params.toString()}`,
    );
    setSlots(result);
  }

  async function handleConfirmBooking() {
    // Defense in depth with the same rule as BookingsController: a STAFF/ADMIN audience must never
    // even attempt the customer-only POST and fall through to a raw FORBIDDEN_ROLE message.
    if (!isCustomerSession || selectedServiceIds.length === 0 || !selectedSlot) return;
    setSubmitting(true);
    setSubmitError(null);
    const tokenStore = sessionTokenStore();
    const attributionToken = campaignKey ? recallCampaign(tokenStore, campaignKey) : null;
    try {
      const booking = await apiFetch<BookingDetailDto>(BOOKING_PATHS.bookings, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          salonId,
          serviceIds: selectedServiceIds,
          slotStart: selectedSlot.slotStart,
          ...(selectedStaffId ? { preferredStaffId: selectedStaffId } : {}),
          ...(selectedStyleName ? { selectedStyleName } : {}),
          ...(creditsToRedeem > 0 ? { creditsToRedeem } : {}),
          ...(attributionToken ? { attributionToken } : {}),
          ...(activeOffer ? { offerId: activeOffer.id } : {}),
        }),
      });
      // One shared link counts for one booking; a later, unrelated booking in this tab is not attributed to it.
      if (campaignKey) forgetCampaign(tokenStore, campaignKey);
      void refreshCurrentAvailability().catch(() => undefined);
      setConfirmedBooking(booking);
      setCreditsToRedeem(0);
      // Redemption never fails/rejects — the server always clamps and the booking always succeeds
      // (see BookingsService.create) — so a successful response can still mean some or all of the
      // requested credits were actually applied. Re-fetch the real balance rather than
      // locally subtracting creditsToRedeem, since the server's actualUsed
      // (booking.creditsRedeemedAmount) may be less than what was requested.
      if (creditsToRedeem > 0) {
        void apiFetch<CustomerCreditBalanceDto>(`${CREDITS_PATHS.credits}/${CREDITS_PATHS.balance}`)
          .then((result) => setCreditsBalance(result.balance))
          .catch(() => undefined);
      }
    } catch (err) {
      // The availability grid is advisory; the booking transaction is authoritative. If another
      // customer won the last capacity concurrently (SLOT_FULL) — or, with a specific barber
      // selected, that exact professional's reservation was just taken or is still held by a
      // booking that completed early but hasn't reached its own slotEnd yet (STAFF_SLOT_UNAVAILABLE
      // — see the booking/queue resource-reservation mission) — clear the stale selection and
      // immediately reload the grid so the occupied state is visible without a page refresh.
      if (
        err instanceof ApiError &&
        (err.code === "SLOT_FULL" || err.code === "STAFF_SLOT_UNAVAILABLE") &&
        selectedDate
      ) {
        setSelectedSlot(null);
        const params = new URLSearchParams({ serviceIds: selectedServiceIds.join(","), date: selectedDate });
        if (selectedStaffId) params.set("staffId", selectedStaffId);
        void apiFetch<AvailabilitySlotDto[]>(
          `${DISCOVERY_PATHS.salons}/${salonId}/booking/${SALON_BOOKING_INFO_PATHS.availability}?${params.toString()}`,
        ).then(setSlots).catch(() => undefined);
      }
      // A failed create (e.g. SLOT_FULL) never reaches the redemption step at all — the whole
      // transaction rolls back — so the wallet balance is genuinely untouched and doesn't need
      // re-fetching here.
      if (err instanceof ApiError && isOfferError(err.code)) setOfferRefused(true);
      setSubmitError(err instanceof ApiError ? customerOfferErrorText(err.code, err.message) : "Could not create the booking. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Google Identity Services renders as an in-page button/overlay, so selections survive both the
  // ordinary anonymous -> customer login and the new STAFF/ADMIN -> CUSTOMER audience switch.
  // AuthService.googleLogin guarantees CUSTOMER role for a linked owner/staff identity without
  // removing their owner/staff DB roles; only this browser session changes audience.
  async function handleGoogleCredential(idToken: string) {
    setSubmitError(null);
    setGoogleSubmitting(true);
    try {
      await googleLogin({ idToken });
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "Could not sign in with Google. Please try again.");
    } finally {
      setGoogleSubmitting(false);
    }
  }

  // Root cause of "can't book a second service": once confirmedBooking was set, this component
  // had no path back to the picker steps at all — the early `if (confirmedBooking) return ...`
  // below is permanent for the lifetime of this component instance, and nothing ever set
  // confirmedBooking back to null. A customer landing back on this same salon's booking page
  // (e.g. via "Book again" or simply not navigating away) was stuck looking at their first
  // booking's confirmation forever, with no way to start another one from this screen. This does
  // NOT touch cancel/reschedule (those correctly update the SAME booking in place) or the
  // create-fails-with-SLOT_FULL path (that already stays on the picker, unaffected) — only the
  // "start a genuinely new booking attempt" gap.
  function handleBookAnother() {
    setConfirmedBooking(null);
    setCancelResult(null);
    setSubmitError(null);
    setSelectedServiceIds([]);
    setSelectedStaffId(undefined);
    setSelectedDate(null);
    setSelectedSlot(null);
    setCreditsToRedeem(0);
  }

  if (confirmedBooking) {
    const booking = confirmedBooking;
    const cancelled = booking.status === "CANCELLED";
    // Part 5 (show arrival time after booking): always converted through the salon's own
    // timezone, never the device's — a customer booking a shop outside their own city/timezone
    // must never be shown a silently-wrong arrival time.
    const arrival = formatBookingArrivalTime(booking.slotStart, booking.salonTimezone);
    const statusClass =
      booking.status === "CONFIRMED"
        ? styles.statusConfirmed
        : booking.status === "PENDING_PAYMENT"
          ? styles.statusPending
          : styles.statusCancelled;
    return (
      <section className={styles.confirmedWrap}>
        <div className={styles.confirmedCard}>
          <div className={styles.confirmedHead}>
            <span className={`${styles.confirmedIcon} ${cancelled ? styles.confirmedIconCancelled : styles.confirmedIconOk}`}>
              {cancelled ? "✕" : "✓"}
            </span>
            <h2 className={styles.confirmedTitle}>{cancelled ? "Booking cancelled" : "Booking confirmed"}</h2>
          </div>
          <p className={styles.summaryLine}>
            <strong>{booking.serviceName}</strong> at {booking.salonName}
          </p>
          {/* Multi-service booking core mission — every selected service, never just a summary
              string, so a multi-service appointment's booking confirmation/detail is honest about
              what was actually booked. A single-service booking (including any created before this
              mission) shows exactly one row here, identical to before. */}
          {booking.services.length > 1 && (
            <ul className={styles.serviceBreakdownList}>
              {booking.services.map((s) => (
                <li key={s.serviceId} className={styles.serviceBreakdownItem}>
                  <span>{s.name}</span>
                  <span>
                    {s.durationMinutes} min · {formatMoney(s.price, currency, countryCode)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.summaryLine}>
            Appointment time: <strong>{arrival.date}, {arrival.time}</strong>
            {!arrival.isDeviceLocalTimezone && " (shop's local time)"}
          </p>
          {/* Part 5 completion (arrival guidance) — derived server-side from the booking's own
              checkInOpensAt/checkInDueBy snapshot (see BookingDetailDto's doc comment); both null
              means no arrival guidance applies (cancelled/completed/already checked in/no policy
              snapshot recorded), so nothing renders rather than a fabricated window. */}
          {booking.checkInOpensAt && booking.checkInDueBy && (
            <p className={styles.summaryLine}>
              Check in between:{" "}
              <strong>
                {formatZonedDateTime(booking.checkInOpensAt, booking.salonTimezone, undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
                {" – "}
                {formatZonedDateTime(booking.checkInDueBy, booking.salonTimezone, undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </strong>
            </p>
          )}
          {booking.offerTitle && (
            <p className={styles.summaryLine}>
              <strong>Offer applied: {booking.offerTitle}.</strong>
              {(booking.onlineBookingDiscountAmount ?? 0) > 0 && <> You save {formatMoney(booking.onlineBookingDiscountAmount ?? 0, currency, countryCode)}.</>}
            </p>
          )}
          {(booking.onlineBookingDiscountPercent ?? 0) > 0 && !booking.offerTitle && (
            <p className={styles.summaryLine}>
              <strong>{booking.onlineBookingDiscountPercent}% FastQue booking offer:</strong>{" "}
              {formatMoney(booking.servicePrice, currency, countryCode)} →{" "}
              {formatMoney(
                booking.discountedServicePrice ??
                  Math.max(0, booking.servicePrice - (booking.onlineBookingDiscountAmount ?? 0)),
                currency,
                countryCode,
              )}
            </p>
          )}
          {booking.selectedStyleName && <p className={styles.summaryLine}>Style: {booking.selectedStyleName}</p>}
          <p className={styles.summaryLine}>
            <span className={`${styles.statusBadge} ${statusClass}`}>{booking.status.replace(/_/g, " ")}</span>
            {booking.status === "PENDING_PAYMENT" && booking.prepaymentRequiredAmount !== null && (
              <> — prepayment of {formatMoney(booking.prepaymentRequiredAmount, currency, countryCode)} required</>
            )}
          </p>
          {!cancelled && paymentInfo?.onlinePaymentAvailable && (
            <div className={styles.summaryLine} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--bc-border)", borderRadius: 12 }}>
              <strong>Pay Online with UPI</strong>
              <span>Amount payable: {formatMoney(booking.payableAmount, currency, countryCode)}</span>
              <BookingUpiAction booking={booking} paymentInfo={paymentInfo} />
              {paymentInfo.paymentQrImageUrl && <img src={paymentInfo.paymentQrImageUrl} alt="Shop UPI payment QR" width={220} height={220} style={{ maxWidth: "100%", objectFit: "contain" }} />}
              <span>Scan this shop QR with your UPI app. Opening/scanning the QR does not make FastQue mark payment as paid; settlement is not automatically verified in V1.</span>
            </div>
          )}
          {booking.creditsRedeemedAmount !== null && booking.creditsRedeemedAmount > 0 && (
            <p className={styles.summaryLine}>
              {formatMoney(booking.creditsRedeemedAmount, currency, countryCode)} in FastQue Credits applied —
              pay {formatMoney(booking.payableAmount, currency, countryCode)} at the shop&apos;s payment QR.
            </p>
          )}
          {cancelResult && (
            <p className={styles.summaryLine}>
              {cancelResult.chargeAmount > 0
                ? `A cancellation charge of ${formatMoney(cancelResult.chargeAmount, currency, countryCode)} has been added to your account.`
                : "No cancellation charge was applied."}
            </p>
          )}
          <div className={styles.confirmedActions}>
            {(booking.status === "CONFIRMED" || booking.status === "PENDING_PAYMENT") && (
              <Button type="button" variant="outline" onClick={() => setShowCancelDialog(true)}>
                Cancel this booking
              </Button>
            )}
            <Button type="button" variant="primary" onClick={handleBookAnother}>
              Book another service
            </Button>
            <Link href="/account/bookings" className={styles.textLink}>
              View my bookings
            </Link>
          </div>
          <BookingActionsBar booking={booking} onReschedule={() => setShowRescheduleDialog(true)} />
        </div>
        {canCheckIn(booking) && <CheckInPanel booking={booking} />}
        {showCancelDialog && (
          <CancelBookingDialog
            booking={booking}
            onClose={() => setShowCancelDialog(false)}
            onCancelled={(result) => {
              setCancelResult(result);
              setConfirmedBooking(result.booking);
              setShowCancelDialog(false);
            }}
          />
        )}
        {showRescheduleDialog && (
          <RescheduleBookingDialog
            booking={booking}
            onClose={() => setShowRescheduleDialog(false)}
            onRescheduled={(updated) => {
              setConfirmedBooking(updated);
              setShowRescheduleDialog(false);
            }}
          />
        )}
      </section>
    );
  }

  // Purely derived from existing selection state, for the step-progress strip only — no new
  // business state, no side effects.
  const progressSteps = [
    { key: "service", label: "Service", done: selectedServiceIds.length > 0 },
    { key: "barber", label: "Barber", done: selectedStaffId !== undefined },
    { key: "date", label: "Date", done: !!selectedDate },
    { key: "time", label: "Time", done: !!selectedSlot },
    { key: "confirm", label: "Confirm", done: false },
  ];
  const currentStepIndex = progressSteps.findIndex((s) => !s.done);

  return (
    <div className={styles.flowRoot}>
      <div className={styles.progress}>
        {progressSteps.map((step, i) => (
          <Fragment key={step.key}>
            <div
              className={`${styles.progressStep} ${step.done ? styles.progressStepDone : ""} ${
                i === currentStepIndex ? styles.progressStepCurrent : ""
              }`}
            >
              <span className={styles.progressDot}>{step.done ? "✓" : i + 1}</span>
              <span className={styles.progressLabel}>{step.label}</span>
            </div>
            {i < progressSteps.length - 1 && <span className={styles.progressRule} />}
          </Fragment>
        ))}
      </div>

      <ServiceStep
        services={services}
        selectedServiceIds={selectedServiceIds}
        onToggle={toggleService}
        currency={currency}
        countryCode={countryCode}
        onlineBookingDiscountPercent={onlineBookingDiscountPercent}
        onContinue={() => document.getElementById("booking-professional")?.focus()}
      />

      {selectedServiceIds.length > 0 && (
        <div id="booking-professional" tabIndex={-1}>
          <StaffStep
            options={staffOptions}
            selectedStaffId={selectedStaffId}
            onSelect={handleSelectStaff}
            loading={staffLoading}
          />
        </div>
      )}

      {selectedServiceIds.length > 0 && selectedStaffId !== undefined && (
        <DateStep
          operatingHours={operatingHours}
          selectedDate={selectedDate}
          onSelect={handleSelectDate}
          salonTimezone={salonTimezone}
        />
      )}

      {selectedDate && (
        <SlotStep
          slots={slots}
          selectedSlot={selectedSlot}
          onSelect={setSelectedSlot}
          loading={slotsLoading}
          salonTimezone={salonTimezone}
        />
      )}

      {selectedSlot && (
        <section className={styles.stepCard}>
          <h2 className={styles.stepHeading}>
            <span className={styles.stepNumber}>5</span> Confirm
          </h2>
          {(() => {
            // Pre-confirmation timezone fix — the exact same formatter/zone the confirmed-booking
            // view above uses (formatBookingArrivalTime + booking.salonTimezone), so this summary
            // can never show a different-looking time than what the customer sees the instant
            // after they actually confirm.
            const arrival = formatBookingArrivalTime(selectedSlot.slotStart, salonTimezone);
            const selectedServices = services.filter((s) => selectedServiceIds.includes(s.id));
            return (
              <>
                <p className={styles.summaryLine}>
                  <strong>{summarizeServiceNames(selectedServices.map((s) => s.name))}</strong> —{" "}
                  {arrival.date}, {arrival.time}
                  {!arrival.isDeviceLocalTimezone && " (shop's local time)"}
                  {selectedStaffId && <> with {staffOptions.find((s) => s.id === selectedStaffId)?.displayName}</>}
                </p>
                {selectedServices.length > 1 && (
                  <ul className={styles.serviceBreakdownList}>
                    {selectedServices.map((s) => (
                      <li key={s.id} className={styles.serviceBreakdownItem}>
                        <span>{s.name}</span>
                        <span>
                          {s.durationMinutes} min · {formatMoney(
                            discountedPrice(s.price, onlineBookingDiscountPercent),
                            currency,
                            countryCode,
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            );
          })()}
          {offerId && offerChecked && !offer && !offerDropped && (
            <p className={styles.summaryLine}>The offer you chose is not available for this shop any more, so this booking uses the normal price.</p>
          )}
          {activeOffer && (() => {
            const est = estimateFor(activeOffer, selectedServiceIds);
            return (
              <div className={styles.summaryLine} data-testid="offer-applied">
                <strong>{activeOffer.title}</strong> — {offerDiscountText(activeOffer)}, {validUntilText(activeOffer.validTo)}.
                {est && est.discount > 0 && (
                  <>
                    {" "}About {formatMoney(est.subtotal, currency, countryCode)} → {formatMoney(est.total, currency, countryCode)} for your services.
                  </>
                )}
                {!appliesToServices(activeOffer, selectedServiceIds) && selectedServiceIds.length > 0 && (
                  <> It does not cover every service you chose, so FastQue may not accept it.</>
                )}
                {" "}This replaces the usual website booking discount. The final price is confirmed by FastQue when you book.
                {offerRefused && (
                  <>
                    {" "}
                    <Button type="button" variant="outline" onClick={() => { setOfferDropped(true); setOfferRefused(false); setSubmitError(null); }}>
                      Book without this offer
                    </Button>
                  </>
                )}
              </div>
            );
          })()}
          {!activeOffer && onlineBookingDiscountPercent > 0 && (
            <p className={styles.summaryLine}>
              <strong>{onlineBookingDiscountPercent}% FastQue booking offer applied.</strong>
            </p>
          )}
          {selectedStyleName && <p className={styles.summaryLine}>Style: {selectedStyleName}</p>}
          {cancellationPolicy && (
            <p className={styles.summaryLine}>
              Free cancellation up to{" "}
              {formatFreeCancellationWindow(cancellationPolicy.effectiveFreeCancellationWindowMinutes)} before your
              appointment.
            </p>
          )}
          {isCustomerSession && creditsBalance !== null && creditsBalance > 0 && (() => {
            // Multi-service booking core mission: the redemption-cap preview must use the COMBINED
            // price of every selected service, never just one — matching the server's own
            // authoritative computation in BookingsService.create.
            const combinedOriginalPaise = services
              .filter((s) => selectedServiceIds.includes(s.id))
              .reduce((sum, s) => sum + numberToPaise(s.price), 0);
            const combinedPrice = paiseToRupees(
              combinedOriginalPaise -
                computePercentageDiscountPaise(
                  combinedOriginalPaise,
                  onlineBookingDiscountPercent,
                ),
            );
            // FastQue Credits / Wallet V1: the redemption cap is price-based (floor(price/50)*10),
            // NOT "whatever the wallet balance happens to be" — a customer can never redeem more
            // than 20% of the combined price even with a much larger balance. This is only a
            // preview; the server independently re-derives and enforces the same cap (see
            // BookingsService.create / CustomerCreditsService.redeemUpTo) regardless of what this
            // slider sends.
            const maxRedeemable = Math.min(creditsBalance, computeMaxRedeemableCredits(combinedPrice));
            if (maxRedeemable <= 0) return null;
            return (
              <div className={styles.summaryLine} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor="credits-redeem">
                  You have {formatMoney(creditsBalance, currency, countryCode)} in FastQue Credits — redeem up to{" "}
                  {formatMoney(maxRedeemable, currency, countryCode)}
                </label>
                <input
                  id="credits-redeem"
                  type="range"
                  min={0}
                  max={maxRedeemable}
                  step={1}
                  value={Math.min(creditsToRedeem, maxRedeemable)}
                  onChange={(e) => setCreditsToRedeem(Number(e.target.value))}
                />
                <p>
                  {creditsToRedeem > 0
                    ? `Applying ${formatMoney(creditsToRedeem, currency, countryCode)} in FastQue Credits — the final payable amount is confirmed by FastQue after the booking is created.`
                    : "Slide to apply credits"}
                </p>
              </div>
            );
          })()}
          <div className={styles.summaryLine} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--bc-border)", borderRadius: 12 }}>
            <strong>Payment</strong>
            {paymentInfo?.onlinePaymentAvailable ? (
              <>
                <span>Pay Online with UPI</span>
                <span>Online UPI payment is available. FastQue will show the shop QR and the exact server-confirmed amount after your booking is created.</span>
              </>
            ) : paymentInfoError ? (
              <span>Online payment information could not be loaded. You can still confirm your booking and pay at the shop.</span>
            ) : paymentInfo ? (
              <span>Online UPI payment is not configured for this shop. You can still confirm your booking and pay at the shop.</span>
            ) : (
              <span>Checking online payment options… You can still confirm your booking.</span>
            )}
          </div>
          {submitError && <p className={styles.errorText}>{submitError}</p>}
          <div className={styles.confirmActions}>
            {isCustomerSession ? (
              <Button type="button" variant="primary" onClick={() => void handleConfirmBooking()} disabled={submitting}>
                {submitting ? "Booking…" : "Confirm booking"}
              </Button>
            ) : authStatus === "loading" ? (
              <p className={styles.summaryLine}>Loading…</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
                <p className={styles.summaryLine}>
                  {authStatus === "authenticated"
                    ? "You are signed in with a shop/admin session. Continue as a customer to confirm this booking — your selected services, barber, date and time will stay selected."
                    : "Sign in to confirm this booking"}
                </p>
                <GoogleIdentityButton
                  audienceLabel="customer"
                  onCredential={(idToken) => void handleGoogleCredential(idToken)}
                  disabled={googleSubmitting}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
