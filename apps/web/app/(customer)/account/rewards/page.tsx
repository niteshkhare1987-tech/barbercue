"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CREDITS_PATHS,
  formatMoney,
  type CustomerCreditBalanceDto,
  type CustomerCreditTransactionDto,
  type PaginatedResult,
} from "@barbercue/shared";
import { apiFetch } from "../../../../lib/api";
import { giftCardsEnabled } from "../../../../lib/dashboard-flags";
import { summarizeCredits } from "../../../../lib/rewards-summary";
import { DashIcon } from "../../../../components/customer-dashboard/icons";
import CreditsHistory from "../credits/page";
import styles from "../../../../components/customer-dashboard/dash.module.css";
import gift from "./rewards.module.css";

type Tab = "credits" | "gifts" | "send" | "received" | "history";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "credits", label: "FastQue Credits" },
  { id: "gifts", label: "My Gift Cards" },
  { id: "send", label: "Send a Gift" },
  { id: "received", label: "Received Gifts" },
  { id: "history", label: "Gift History" },
];

export default function RewardsPage() {
  return (
    <Suspense fallback={null}>
      <Rewards />
    </Suspense>
  );
}

function Rewards() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "credits") as Tab;

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Rewards &amp; Gifts</h1>
          <p className={styles.sub}>Your FastQue Credits and, soon, salon gift cards.</p>
        </div>
      </div>
      <div className={styles.tabs} role="tablist" aria-label="Rewards">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.tab}
            onClick={() => router.replace(`${pathname}${t.id === "credits" ? "" : `?tab=${t.id}`}`, { scroll: false })}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "credits" ? <CreditsTab /> : tab === "send" ? <SendGift /> : <GiftsUnavailable tab={tab} />}
    </div>
  );
}

function CreditsTab() {
  const [balance, setBalance] = useState<number | null>(null);
  const [history, setHistory] = useState<{ items: CustomerCreditTransactionDto[]; complete: boolean } | null>(null);

  useEffect(() => {
    apiFetch<CustomerCreditBalanceDto>(`${CREDITS_PATHS.credits}/${CREDITS_PATHS.balance}`).then((r) => setBalance(r.balance)).catch(() => undefined);
    apiFetch<PaginatedResult<CustomerCreditTransactionDto>>(`${CREDITS_PATHS.credits}/${CREDITS_PATHS.history}`)
      .then((page) => setHistory({ items: page.items, complete: page.nextCursor === null }))
      .catch(() => undefined);
  }, []);

  const summary = useMemo(() => (history ? summarizeCredits(history.items, new Date()) : null), [history]);
  const partial = history && !history.complete ? " (recent)" : "";

  return (
    <>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <strong>{balance === null ? "—" : formatMoney(balance, "INR", "IN")}</strong>
          <span>Available credits</span>
        </div>
        <div className={styles.stat}>
          <strong>{summary ? formatMoney(summary.earned, "INR", "IN") : "—"}</strong>
          <span>Credits received{partial}</span>
        </div>
        <div className={styles.stat}>
          <strong>{summary ? formatMoney(summary.redeemed, "INR", "IN") : "—"}</strong>
          <span>Credits used{partial}</span>
        </div>
        <div className={styles.stat}>
          <strong>{summary ? formatMoney(summary.expiringSoon, "INR", "IN") : "—"}</strong>
          <span>Expiring in 30 days{partial}</span>
        </div>
      </div>
      <p className={styles.notice}>
        FastQue Credits are granted by FastQue promotions and can reduce eligible booking prices. Completing a visit does not
        earn credits automatically, and pending points don’t exist in this programme. Every figure comes from your credit ledger.
      </p>
      <CreditsHistory />
      <section className={styles.card} aria-labelledby="referral-title">
        <h2 id="referral-title" className={styles.sectionTitle}>
          <span className={styles.cardIcon}><DashIcon name="queue" /></span>Refer a friend
        </h2>
        <p className={styles.meta} style={{ marginTop: 8 }}>
          A referral programme isn’t available yet. When it launches, its rules and rewards will be shown here before you share
          anything. Meanwhile you can share any salon from its card with the share button.
        </p>
      </section>
    </>
  );
}

function GiftsUnavailable({ tab }: { tab: Tab }) {
  const copy: Record<string, { title: string; text: string }> = {
    gifts: { title: "No gift cards", text: "You don’t have any FastQue gift cards." },
    received: { title: "No gifts received", text: "Gift cards sent to you will appear here." },
    history: { title: "No gift card activity", text: "Purchases, deliveries and redemptions will be listed here." },
  };
  const c = copy[tab] ?? copy.gifts;
  return (
    <>
      {!giftCardsEnabled() && <ComingSoon />}
      <div className={styles.empty}>
        <span className={styles.emptyIcon}><DashIcon name="gift" size={26} /></span>
        <h2>{c.title}</h2>
        <p>{c.text}</p>
      </div>
    </>
  );
}

function ComingSoon() {
  return (
    <p className={styles.notice}>
      <strong>Salon gift cards are coming soon.</strong> They can’t be bought, sent or redeemed yet — we’ll switch them on once
      payments, settlement with salons and the applicable rules are fully in place.
    </p>
  );
}

const AMOUNTS = [500, 1000, 2000, 5000];

/** Gift flow preview. No payment is taken and no gift card is created: the pay step is disabled. */
function SendGift() {
  const enabled = giftCardsEnabled();
  const [amount, setAmount] = useState(1000);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <ComingSoon />
      <div className={gift.layout}>
        <form className={styles.card} onSubmit={(e) => e.preventDefault()} aria-label="Gift card details (preview)">
          <fieldset className={gift.fieldset} disabled={!enabled}>
            <legend className={styles.sectionTitle}>1. Choose an amount</legend>
            <div className={styles.chips}>
              {AMOUNTS.map((a) => (
                <button key={a} type="button" className={styles.chip} aria-pressed={amount === a} onClick={() => setAmount(a)}>
                  {formatMoney(a, "INR", "IN")}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className={gift.fieldset} disabled={!enabled}>
            <legend className={styles.sectionTitle}>2. Who is it for?</legend>
            <label className={styles.field}>Recipient name<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
            <label className={styles.field}>Mobile number or email<input value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} /></label>
            <label className={styles.field}>
              Personal message
              <textarea value={message} maxLength={200} rows={3} onChange={(e) => setMessage(e.target.value)} className={gift.textarea} />
            </label>
            <label className={styles.field}>Delivery date (optional)<input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </fieldset>
          <button type="button" className={styles.btnPrimary} disabled title="Gift card payments are not enabled yet">
            Pay &amp; send — not available yet
          </button>
        </form>
        <div>
          <p className={styles.meta} style={{ marginBottom: 8 }}>3. Preview</p>
          <div className={gift.card} aria-label="Gift card preview">
            <span className={gift.brand}>FastQue Gift Card</span>
            <strong className={gift.amount}>{formatMoney(amount, "INR", "IN")}</strong>
            <span>For {name.trim() || "your friend"}</span>
            {message.trim() && <em className={gift.message}>“{message.trim()}”</em>}
            <span className={gift.sample}>Preview only — not a valid gift card</span>
          </div>
        </div>
      </div>
    </>
  );
}

