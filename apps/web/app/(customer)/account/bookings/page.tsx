"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BOOKING_PATHS,
  DATE_RANGE_PRESETS,
  QUEUE_ENTRIES_PATH,
  formatBookingArrivalTime,
  formatMoney,
  formatZonedDateTime,
  isCustomerBookingActionable,
  isCustomerBookingUpcoming,
  presetRange,
  type DateRangePreset,
} from "@barbercue/shared";
import type {
  BookingDetailDto,
  CancelBookingResponseDto,
  InvoiceListDto,
  InvoiceSummaryDto,
  PaginatedResult,
  QueueEntryDetailDto,
} from "@barbercue/shared";
import { apiFetch, apiFetchBlob, ApiError } from "../../../../lib/api";
import { getRealtimeSocket, onReconnect } from "../../../../lib/realtime";
import { useAssistantRefresh } from "../../../../lib/assistant-events";
import { triggerBlobDownload } from "../../../../components/owner/format";
import { CancelBookingDialog } from "../../../../components/booking/CancelBookingDialog";
import { RescheduleBookingDialog } from "../../../../components/booking/RescheduleBookingDialog";
import { BookingActionsBar } from "../../../../components/booking/BookingActionsBar";
import { ReviewPanel } from "../../../../components/booking/ReviewPanel";
import { ShopContactNote } from "../../../../components/booking/ShopContactNote";
import { CheckInPanel, canCheckIn } from "../../../../components/queue/CheckInPanel";
import { QueueStatusPanel } from "../../../../components/queue/QueueStatusPanel";
import { FavoriteButton } from "../../../../components/discovery/FavoriteButton";
import { DashIcon } from "../../../../components/customer-dashboard/icons";
import styles from "../../../../components/customer-dashboard/dash.module.css";

type Tab = "upcoming" | "queue" | "completed" | "cancelled" | "all";
type Sort = "newest" | "oldest" | "amountHigh" | "amountLow";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "upcoming", label: "Upcoming" },
  { id: "queue", label: "Live Queue" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "all", label: "All Appointments" },
];

const TAB_STATUS: Record<Exclude<Tab, "queue">, string | null> = {
  upcoming: "CONFIRMED,PENDING_PAYMENT",
  completed: "COMPLETED",
  cancelled: "CANCELLED,NO_SHOW,EXPIRED",
  all: null,
};

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  CONFIRMED: { label: "Confirmed", tone: styles.badgeGreen },
  PENDING_PAYMENT: { label: "Payment pending", tone: styles.badgeAmber },
  COMPLETED: { label: "Completed", tone: styles.badgeNavy },
  CANCELLED: { label: "Cancelled", tone: "" },
  NO_SHOW: { label: "No-show", tone: styles.badgeRed },
  EXPIRED: { label: "Expired", tone: "" },
};

const CANCELLABLE = new Set(["CONFIRMED", "PENDING_PAYMENT"]);

function whenText(booking: BookingDetailDto): string {
  const arrival = formatBookingArrivalTime(booking.slotStart, booking.salonTimezone);
  return `${arrival.date} · ${arrival.time}${arrival.isDeviceLocalTimezone ? "" : " (shop’s local time)"}`;
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <Appointments />
    </Suspense>
  );
}

function Appointments() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "upcoming") as Tab;
  const preset = (DATE_RANGE_PRESETS.find((p) => p.id === params.get("range"))?.id ?? null) as DateRangePreset | null;
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const salonFilter = params.get("salonId");
  const serviceFilter = params.get("service");
  const sort = (["newest", "oldest", "amountHigh", "amountLow"].includes(params.get("sort") ?? "") ? params.get("sort") : tab === "upcoming" ? "oldest" : "newest") as Sort;

  const [items, setItems] = useState<BookingDetailDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [queue, setQueue] = useState<QueueEntryDetailDto | null | undefined>(undefined);
  const [invoicesByBooking, setInvoicesByBooking] = useState<Map<string, InvoiceSummaryDto>>(new Map());
  const [summary, setSummary] = useState<{ upcoming: string; completed: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BookingDetailDto | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<BookingDetailDto | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  }

  const query = useMemo(() => {
    if (tab === "queue") return null;
    const q = new URLSearchParams();
    const status = TAB_STATUS[tab];
    if (status) q.set("status", status);
    if (tab === "upcoming") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      q.set("from", presetRange("today", yesterday).from);
    } else if (preset) {
      const range = presetRange(preset);
      q.set("from", range.from);
      q.set("to", range.to);
    } else {
      if (customFrom) q.set("from", customFrom);
      if (customTo) q.set("to", customTo);
    }
    if (salonFilter) q.set("salonId", salonFilter);
    q.set("sort", sort === "oldest" ? "oldest" : "newest");
    return q;
  }, [tab, preset, customFrom, customTo, salonFilter, sort]);

  const fetchPage = useCallback(
    (after?: string) => {
      if (!query) return Promise.resolve(null);
      const q = new URLSearchParams(query);
      if (after) q.set("cursor", after);
      return apiFetch<PaginatedResult<BookingDetailDto>>(`${BOOKING_PATHS.bookings}/${BOOKING_PATHS.mine}?${q}`);
    },
    [query],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return null;
        setItems(null);
        setError(null);
        return fetchPage();
      })
      .then((page) => {
        if (cancelled || !page) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "Couldn’t load your appointments."));
    return () => {
      cancelled = true;
    };
  }, [fetchPage, reloadKey]);

  const loadQueue = useCallback(() => {
    apiFetch<QueueEntryDetailDto | null>(`${QUEUE_ENTRIES_PATH}/mine/active`).then(setQueue).catch(() => setQueue(null));
  }, []);
  useEffect(loadQueue, [loadQueue]);

  // Invoices issued for the customer's bookings (first page), to link "Download invoice".
  useEffect(() => {
    apiFetch<InvoiceListDto>("invoices/mine?limit=50")
      .then((page) => setInvoicesByBooking(new Map(page.items.filter((i) => i.bookingId).map((i) => [i.bookingId!, i]))))
      .catch(() => undefined);
  }, []);

  // Compact history summary from real records ("+" when more exist than one page shows).
  useEffect(() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const base = `${BOOKING_PATHS.bookings}/${BOOKING_PATHS.mine}`;
    Promise.all([
      apiFetch<PaginatedResult<BookingDetailDto>>(`${base}?status=CONFIRMED,PENDING_PAYMENT&from=${presetRange("today", yesterday).from}`),
      apiFetch<PaginatedResult<BookingDetailDto>>(`${base}?status=COMPLETED`),
    ])
      .then(([up, done]) =>
        setSummary({
          upcoming: `${up.items.filter((b) => isCustomerBookingUpcoming(b)).length}${up.nextCursor ? "+" : ""}`,
          completed: `${done.items.length}${done.nextCursor ? "+" : ""}`,
        }),
      )
      .catch(() => undefined);
  }, [reloadKey]);

  useAssistantRefresh("myBookings", () => setReloadKey((k) => k + 1));
  useAssistantRefresh("myQueue", loadQueue);

  // A false NO_SHOW corrected by the shop: refetch backend truth (never guess).
  useEffect(() => {
    const socket = getRealtimeSocket();
    const refresh = () => setReloadKey((k) => k + 1);
    socket.on("booking.corrected", refresh);
    const off = onReconnect(refresh);
    return () => {
      socket.off("booking.corrected", refresh);
      off();
    };
  }, []);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      if (page) {
        setItems((cur) => [...(cur ?? []), ...page.items]);
        setCursor(page.nextCursor);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t load more appointments.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function downloadInvoice(invoice: InvoiceSummaryDto) {
    setDownloading(invoice.id);
    try {
      const { blob, filename } = await apiFetchBlob(`invoices/mine/${invoice.id}/pdf`);
      triggerBlobDownload(blob, filename ?? `${invoice.number}.pdf`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t download this invoice.");
    } finally {
      setDownloading(null);
    }
  }

  function replaceBooking(updated: BookingDetailDto) {
    setItems((cur) => cur?.map((b) => (b.id === updated.id ? updated : b)) ?? null);
  }

  // Salon / service filter options come from the customer's own loaded appointments.
  const salonOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of items ?? []) map.set(b.salonId, b.salonName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const serviceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const b of items ?? []) for (const s of b.services.length ? b.services.map((x) => x.name) : [b.serviceName]) set.add(s);
    return [...set].sort();
  }, [items]);

  const shown = useMemo(() => {
    let list = items ?? [];
    if (tab === "upcoming") list = list.filter((b) => isCustomerBookingUpcoming(b));
    if (serviceFilter) list = list.filter((b) => (b.services.length ? b.services.map((s) => s.name) : [b.serviceName]).includes(serviceFilter));
    if (sort === "amountHigh") list = [...list].sort((a, b) => b.payableAmount - a.payableAmount);
    if (sort === "amountLow") list = [...list].sort((a, b) => a.payableAmount - b.payableAmount);
    return list;
  }, [items, tab, serviceFilter, sort]);

  const filtersActive = !!(preset || customFrom || customTo || salonFilter || serviceFilter);

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>My Appointments</h1>
          <p className={styles.sub}>Upcoming visits, your live queue and your service history.</p>
        </div>
        <Link href="/account/discover" className={styles.btnPrimary}>Book an Appointment</Link>
      </div>

      {summary && (
        <div className={styles.stats}>
          <div className={styles.stat}><strong>{summary.upcoming}</strong><span>Upcoming appointments</span></div>
          <div className={styles.stat}><strong>{summary.completed}</strong><span>Completed visits</span></div>
          <div className={styles.stat}><strong>{queue ? "1" : "0"}</strong><span>Active live queue</span></div>
        </div>
      )}

      <div className={styles.tabs} role="tablist" aria-label="Appointments">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.tab}
            onClick={() => update({ tab: t.id === "upcoming" ? null : t.id, sort: null })}
          >
            {t.label}
            {t.id === "queue" && queue && <span className={`${styles.badge} ${styles.badgeGreen}`}>Live</span>}
          </button>
        ))}
      </div>

      {tab !== "queue" && (
        <div className={styles.filters} aria-label="Filter appointments">
          {tab !== "upcoming" && (
            <>
              <label className={styles.field}>
                Date
                <select
                  value={preset ?? (customFrom || customTo ? "custom" : "")}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "custom") update({ range: null, from: customFrom ?? presetRange("30d").from, to: customTo ?? presetRange("30d").to });
                    else update({ range: v || null, from: null, to: null });
                  }}
                >
                  <option value="">Any time</option>
                  {DATE_RANGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value="custom">Custom range</option>
                </select>
              </label>
              {!preset && (customFrom || customTo) && (
                <>
                  <label className={styles.field}>From<input type="date" value={customFrom ?? ""} max={customTo ?? undefined} onChange={(e) => update({ from: e.target.value })} /></label>
                  <label className={styles.field}>To<input type="date" value={customTo ?? ""} min={customFrom ?? undefined} onChange={(e) => update({ to: e.target.value })} /></label>
                </>
              )}
            </>
          )}
          <label className={styles.field}>
            Salon
            <select value={salonFilter ?? ""} onChange={(e) => update({ salonId: e.target.value || null })}>
              <option value="">All salons</option>
              {salonOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              {salonFilter && !salonOptions.some(([id]) => id === salonFilter) && <option value={salonFilter}>Selected salon</option>}
            </select>
          </label>
          <label className={styles.field}>
            Service
            <select value={serviceFilter ?? ""} onChange={(e) => update({ service: e.target.value || null })}>
              <option value="">All services</option>
              {serviceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            Sort
            <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="amountHigh">Amount: high to low</option>
              <option value="amountLow">Amount: low to high</option>
            </select>
          </label>
          {filtersActive && (
            <button type="button" className={styles.btnGhost} onClick={() => update({ range: null, from: null, to: null, salonId: null, service: null })}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}

      {tab === "queue" && (
        queue === undefined ? (
          <div className={styles.skeleton} style={{ height: 160 }} aria-label="Loading live queue" />
        ) : queue ? (
          <section className={styles.card} aria-label="Your live queue">
            <QueueStatusPanel entry={queue} onEntryChange={setQueue} />
          </section>
        ) : (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}><DashIcon name="queue" size={26} /></span>
            <h2>You’re not in a live queue</h2>
            <p>Join a salon’s live queue and track your turn here in real time.</p>
            <Link href="/account/discover?openNow=true" className={styles.btnPrimary}>Find a salon open now</Link>
          </div>
        )
      )}

      {tab !== "queue" && items === null && !error && (
        <div className={styles.list} aria-busy="true" aria-label="Loading appointments">
          {[0, 1, 2].map((i) => <div key={i} className={styles.skeleton} style={{ height: 120 }} />)}
        </div>
      )}

      {tab !== "queue" && items !== null && shown.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><DashIcon name="calendar" size={26} /></span>
          <h2>{filtersActive ? "No appointments match these filters" : "Your next great look is waiting."}</h2>
          <p>{filtersActive ? "Try a wider date range or clear the filters." : "Find a salon, pick a time, and it will show up here."}</p>
          {filtersActive ? (
            <button type="button" className={styles.btn} onClick={() => update({ range: null, from: null, to: null, salonId: null, service: null })}>Clear filters</button>
          ) : (
            <Link href="/account/discover" className={styles.btnPrimary}>Find a Salon</Link>
          )}
        </div>
      )}

      {tab !== "queue" && shown.length > 0 && (
        <div className={styles.list}>
          {shown.map((booking) => {
            const status = STATUS_TEXT[booking.status] ?? { label: booking.status, tone: "" };
            const invoice = invoicesByBooking.get(booking.id);
            const services = booking.services.length ? booking.services.map((s) => s.name).join(" + ") : booking.serviceName;
            const profileHref = `/${booking.salonCountryCode.toLowerCase()}/${booking.citySlug}/${booking.salonSlug}`;
            return (
              <article key={booking.id} id={`booking-${booking.id}`} className={styles.card} style={{ scrollMarginTop: 180 }}>
                <div className={styles.cardHead} style={{ alignItems: "start" }}>
                  <div className={styles.rowMain}>
                    <h2 className={styles.rowTitle}><Link href={profileHref}>{booking.salonName}</Link></h2>
                    <p className={styles.meta}>{services}</p>
                    <p className={styles.meta}>{whenText(booking)}</p>
                    {booking.preferredStaffName && <p className={styles.meta}>Stylist: {booking.preferredStaffName}</p>}
                    {booking.checkInDueBy && isCustomerBookingUpcoming(booking) && (
                      <p className={styles.meta}>
                        Check in by {formatZonedDateTime(booking.checkInDueBy, booking.salonTimezone, undefined, { hour: "numeric", minute: "2-digit" })}
                      </p>
                    )}
                    <p className={styles.meta}>Booking ID: {shortId(booking.id)} · Scheduled</p>
                  </div>
                  <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                    <span className={`${styles.badge} ${status.tone}`}>{status.label}</span>
                    <span className={styles.amount}>{formatMoney(booking.payableAmount, booking.currency)}</span>
                    {booking.status === "COMPLETED" && <FavoriteButton salonId={booking.salonId} salonName={booking.salonName} variant="inline" />}
                  </div>
                </div>

                {booking.cancellationChargeAmount !== null && booking.cancellationChargeAmount > 0 && (
                  <>
                    <p className={styles.meta}>Cancellation charge: {formatMoney(booking.cancellationChargeAmount, booking.currency)}</p>
                    <ShopContactNote shopPhone={booking.shopPhone} salonName={booking.salonName} purpose="charge" />
                  </>
                )}

                {booking.status === "COMPLETED" && (
                  <p className={styles.meta} style={{ marginTop: 8 }}>
                    {invoice ? (
                      <button type="button" className={styles.btnGhost} disabled={downloading === invoice.id} onClick={() => void downloadInvoice(invoice)}>
                        {downloading === invoice.id ? "Preparing invoice…" : `Download invoice ${invoice.number}`}
                      </button>
                    ) : (
                      "Invoice not available — the shop hasn’t issued one for this visit."
                    )}
                  </p>
                )}

                <div className={styles.actions} style={{ marginTop: 10 }}>
                  {CANCELLABLE.has(booking.status) && isCustomerBookingActionable(booking) && (
                    <button type="button" className={styles.btn} onClick={() => setCancelTarget(booking)}>Cancel</button>
                  )}
                </div>
                <BookingActionsBar booking={booking} onReschedule={setRescheduleTarget} />
                {canCheckIn(booking) && <CheckInPanel booking={booking} />}
                <ReviewPanel booking={booking} onReviewed={(id) => setItems((cur) => cur?.map((b) => (b.id === id ? { ...b, hasReview: true } : b)) ?? null)} />
              </article>
            );
          })}
        </div>
      )}

      {tab !== "queue" && cursor && (
        <div>
          <button type="button" className={styles.btn} onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      <p className={styles.meta}>Past live-queue visits aren’t listed here yet; scheduled appointments and check-ins are.</p>

      {cancelTarget && (
        <CancelBookingDialog
          booking={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={(result: CancelBookingResponseDto) => {
            replaceBooking(result.booking);
            setCancelTarget(null);
          }}
        />
      )}
      {rescheduleTarget && (
        <RescheduleBookingDialog
          booking={rescheduleTarget}
          onClose={() => setRescheduleTarget(null)}
          onRescheduled={(updated) => {
            replaceBooking(updated);
            setRescheduleTarget(null);
          }}
        />
      )}
    </div>
  );
}
