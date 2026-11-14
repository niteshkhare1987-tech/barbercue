"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  BOOKING_PATHS,
  CREDITS_PATHS,
  NOTIFICATION_PATHS,
  QUEUE_ENTRIES_PATH,
  formatBookingArrivalTime,
  formatMoney,
  greetingForHour,
  isCustomerBookingUpcoming,
  presetRange,
} from "@barbercue/shared";
import type {
  BookingDetailDto,
  CustomerCreditBalanceDto,
  NotificationDto,
  PaginatedResult,
  QueueEntryDetailDto,
} from "@barbercue/shared";
import { apiFetch } from "../../../lib/api";
import { useAssistantRefresh } from "../../../lib/assistant-events";
import { useFavorites } from "../../../lib/favorites";
import { giftCardsEnabled } from "../../../lib/dashboard-flags";
import { directionsUrl } from "../../../lib/booking-actions";
import { QueueStatusPanel } from "../../../components/queue/QueueStatusPanel";
import { RecentlyViewedList } from "../../../components/customer-dashboard/RecentlyViewedList";
import { DashIcon, type IconName } from "../../../components/customer-dashboard/icons";
import { TYPE_LABEL, timeAgo } from "../../../components/layout/NotificationBell";
import styles from "../../../components/customer-dashboard/dash.module.css";
import home from "./home.module.css";

const noopSubscribe = () => () => undefined;

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; data: T };

const QUICK_ACTIONS: Array<{ href: string; label: string; icon: IconName; hint: string }> = [
  { href: "/account/discover", label: "Book an Appointment", icon: "calendar", hint: "Pick a salon and a time" },
  { href: "/account/discover?openNow=true", label: "Join Live Queue", icon: "queue", hint: "Salons open right now" },
  { href: "/account/bookings", label: "View Appointments", icon: "clock", hint: "Upcoming and past visits" },
  { href: "/account/rewards", label: "My Rewards", icon: "trophy", hint: "FastQue Credits" },
];

function whenLabel(booking: BookingDetailDto): string {
  const arrival = formatBookingArrivalTime(booking.slotStart, booking.salonTimezone);
  return `${arrival.date} · ${arrival.time}${arrival.isDeviceLocalTimezone ? "" : " (shop time)"}`;
}

/** Customer dashboard home. Every figure comes from the customer's own records; nothing is sample data. */
export default function DashboardHomePage() {
  // Viewer's local hour; the server render (no clock of the viewer's) says "Welcome back".
  const greeting = useSyncExternalStore(noopSubscribe, () => greetingForHour(new Date().getHours()), () => "Welcome back");
  const [queue, setQueue] = useState<QueueEntryDetailDto | null>(null);
  const [next, setNext] = useState<Load<BookingDetailDto | null>>({ state: "loading" });
  const [credits, setCredits] = useState<Load<number>>({ state: "loading" });
  const [activity, setActivity] = useState<Load<NotificationDto[]>>({ state: "loading" });
  const { savedIds, loaded: favoritesLoaded } = useFavorites();


  function loadQueue() {
    apiFetch<QueueEntryDetailDto | null>(`${QUEUE_ENTRIES_PATH}/mine/active`).then(setQueue).catch(() => undefined);
  }
  function loadNext() {
    // Yesterday (local) as the lower bound covers every salon time zone; upcoming-ness is then
    // checked exactly by the shared rule.
    const query = new URLSearchParams({ status: "CONFIRMED,PENDING_PAYMENT", sort: "oldest" });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    query.set("from", presetRange("today", yesterday).from);
    apiFetch<PaginatedResult<BookingDetailDto>>(`${BOOKING_PATHS.bookings}/${BOOKING_PATHS.mine}?${query}`)
      .then((page) => setNext({ state: "ready", data: page.items.find((b) => isCustomerBookingUpcoming(b)) ?? null }))
      .catch(() => setNext({ state: "error" }));
  }

  useEffect(() => {
    loadQueue();
    loadNext();
    apiFetch<CustomerCreditBalanceDto>(`${CREDITS_PATHS.credits}/${CREDITS_PATHS.balance}`)
      .then((r) => setCredits({ state: "ready", data: r.balance }))
      .catch(() => setCredits({ state: "error" }));
    apiFetch<{ items: NotificationDto[] }>(`${NOTIFICATION_PATHS.notifications}/${NOTIFICATION_PATHS.mine}`)
      .then((r) => setActivity({ state: "ready", data: r.items.slice(0, 5) }))
      .catch(() => setActivity({ state: "error" }));
  }, []);
  useAssistantRefresh("myQueue", loadQueue);
  useAssistantRefresh("myBookings", loadNext);

  return (
    <div className={styles.page}>
      <header className={home.hero}>
        <div>
          <h1 className={home.greeting}>
            {greeting}! <span aria-hidden="true">👋</span>
          </h1>
          <p className={home.lead}>Ready for your next great look?</p>
        </div>
        <nav className={home.quick} aria-label="Quick actions">
          {QUICK_ACTIONS.map((action) => (
            <Link key={action.href} href={action.href} className={home.quickCard}>
              <span className={home.quickIcon}><DashIcon name={action.icon} size={24} /></span>
              <strong>{action.label}</strong>
              <span>{action.hint}</span>
            </Link>
          ))}
        </nav>
      </header>

      {/* An active live-queue entry always comes first. */}
      {queue && (
        <section className={`${styles.card} ${home.queueCard}`} aria-labelledby="live-queue-title">
          <div className={styles.cardHead}>
            <h2 id="live-queue-title" className={styles.sectionTitle}>
              Your Live Queue <span className={`${styles.badge} ${styles.badgeGreen}`}>In queue</span>
            </h2>
            <Link href="/account/bookings?tab=queue" className={styles.btnGhost}>Track live queue →</Link>
          </div>
          <QueueStatusPanel entry={queue} onEntryChange={setQueue} />
        </section>
      )}

      <div className={styles.grid3}>
        <section className={styles.card} aria-labelledby="next-title">
          <div className={styles.cardHead}>
            <h2 id="next-title" className={styles.sectionTitle}>
              <span className={styles.cardIcon}><DashIcon name="calendar" /></span>Your Next Appointment
            </h2>
          </div>
          {next.state === "loading" && <div className={styles.skeleton} style={{ height: 110 }} aria-label="Loading" />}
          {next.state === "error" && <p className={styles.meta}>Couldn’t load your appointments. <Link href="/account/bookings">Open appointments</Link></p>}
          {next.state === "ready" && next.data && (
            <div className={home.nextBody}>
              <p className={home.when}>{whenLabel(next.data)}</p>
              <p className={home.salon}>{next.data.salonName}</p>
              <p className={styles.meta}>{next.data.services.map((s) => s.name).join(" + ") || next.data.serviceName}</p>
              {next.data.preferredStaffName && <p className={styles.meta}>With {next.data.preferredStaffName}</p>}
              <p className={styles.meta}>
                <strong className={styles.amount}>{formatMoney(next.data.payableAmount, next.data.currency)}</strong>
              </p>
              <div className={styles.actions}>
                <Link href={`/account/bookings#booking-${next.data.id}`} className={styles.btn}>View Details</Link>
                <a href={directionsUrl(next.data)} target="_blank" rel="noopener noreferrer" className={styles.btnPrimary}>
                  Directions
                </a>
              </div>
            </div>
          )}
          {next.state === "ready" && !next.data && (
            <div className={home.miniEmpty}>
              <p>Your next great look is waiting.</p>
              <Link href="/account/discover" className={styles.btnPrimary}>Find a Salon</Link>
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="rewards-title">
          <div className={styles.cardHead}>
            <h2 id="rewards-title" className={styles.sectionTitle}>
              <span className={styles.cardIcon}><DashIcon name="trophy" /></span>Your Rewards
            </h2>
          </div>
          {credits.state === "loading" && <div className={styles.skeleton} style={{ height: 80 }} aria-label="Loading" />}
          {credits.state === "error" && <p className={styles.meta}>Couldn’t load your credits right now.</p>}
          {credits.state === "ready" && (
            <>
              <p className={home.bigNumber}>{formatMoney(credits.data, "INR", "IN")}</p>
              <p className={styles.meta}>FastQue Credits available</p>
            </>
          )}
          <Link href="/account/rewards" className={styles.btnGhost} style={{ marginTop: 10 }}>View Rewards →</Link>
        </section>

        <section className={styles.card} aria-labelledby="gift-title">
          <div className={styles.cardHead}>
            <h2 id="gift-title" className={styles.sectionTitle}>
              <span className={styles.cardIcon}><DashIcon name="gift" /></span>Gift Cards
            </h2>
          </div>
          {giftCardsEnabled() ? (
            <p className={styles.meta}>Gift cards are in preview. No gift card can be bought or redeemed yet.</p>
          ) : (
            <p className={styles.meta}>Salon gift cards are coming soon. You don’t have any gift cards.</p>
          )}
          <Link href="/account/rewards?tab=gifts" className={styles.btnGhost} style={{ marginTop: 10 }}>Learn more →</Link>
        </section>
      </div>

      <div className={home.split}>
        <section className={styles.card} aria-labelledby="discover-title">
          <div className={styles.cardHead}>
            <h2 id="discover-title" className={styles.sectionTitle}>Pick up where you left off</h2>
            <div className={styles.actions}>
              <Link href="/account/discover?favorites=1" className={styles.btn}>
                Favourites{favoritesLoaded ? ` (${savedIds.size})` : ""}
              </Link>
              <Link href="/account/discover" className={styles.btnPrimary}>Discover Salons</Link>
            </div>
          </div>
          <RecentlyViewedList limit={3} compact />
          <Link href="/account/discover?tab=recent" className={styles.btnGhost} style={{ marginTop: 10 }}>All recently viewed →</Link>
        </section>

        <section className={styles.card} aria-labelledby="activity-title">
          <div className={styles.cardHead}>
            <h2 id="activity-title" className={styles.sectionTitle}>
              <span className={styles.cardIcon}><DashIcon name="clock" /></span>Recent Activity
            </h2>
          </div>
          {activity.state === "loading" && <div className={styles.skeleton} style={{ height: 120 }} aria-label="Loading" />}
          {activity.state === "error" && <p className={styles.meta}>Couldn’t load recent activity.</p>}
          {activity.state === "ready" && activity.data.length === 0 && (
            <p className={styles.meta}>Booking updates, queue alerts and credits will show up here.</p>
          )}
          {activity.state === "ready" && activity.data.length > 0 && (
            <ul className={home.activity}>
              {activity.data.map((n) => (
                <li key={n.id} className={n.readAt ? undefined : home.unread}>
                  {n.deepLink ? <Link href={n.deepLink}>{TYPE_LABEL[n.type] ?? "Update"}</Link> : <span>{TYPE_LABEL[n.type] ?? "Update"}</span>}
                  <small>{timeAgo(n.createdAt)}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
