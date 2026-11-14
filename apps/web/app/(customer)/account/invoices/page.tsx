"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CUSTOMER_INVOICE_PAYMENT_FILTERS,
  DATE_RANGE_PRESETS,
  presetRange,
  type DateRangePreset,
  type InvoiceDetailDto,
  type InvoiceListDto,
  type InvoiceSummaryDto,
} from "@barbercue/shared";
import { apiFetch, apiFetchBlob, ApiError } from "../../../../lib/api";
import { formatMoney, triggerBlobDownload } from "../../../../components/owner/format";
import { DashIcon } from "../../../../components/customer-dashboard/icons";
import styles from "../../../../components/customer-dashboard/dash.module.css";

const STATUS: Record<string, { label: string; tone: string }> = {
  UNPAID: { label: "Unpaid", tone: styles.badgeAmber },
  PARTIALLY_PAID: { label: "Partly paid", tone: styles.badgeAmber },
  PAID: { label: "Paid", tone: styles.badgeGreen },
  REFUNDED: { label: "Refunded", tone: styles.badgeNavy },
};

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// A customer's own invoices: only invoices a shop issued to THIS account for completed services
// (ownership is in the API's WHERE). The salon is the issuer; "Paid" is what the shop recorded, not
// a FastQue payment receipt. Nothing here generates or alters an invoice.
export default function MyInvoicesPage() {
  const [items, setItems] = useState<InvoiceSummaryDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRangePreset | "">("");
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [payment, setPayment] = useState("");
  const [salon, setSalon] = useState("");
  const [detail, setDetail] = useState<InvoiceDetailDto | null>(null);
  const [salonNames, setSalonNames] = useState<Map<string, string>>(new Map());

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (range) {
      const r = presetRange(range);
      p.set("from", r.from);
      p.set("to", r.to);
    }
    if (appliedQ) p.set("q", appliedQ);
    if (salon) p.set("salonId", salon);
    return p;
  }, [range, appliedQ, salon]);

  const load = useCallback(
    (cursor?: string) => {
      const p = new URLSearchParams(query);
      if (cursor) p.set("cursor", cursor);
      return apiFetch<InvoiceListDto>(`invoices/mine${p.size ? `?${p}` : ""}`)
        .then((page) => {
          setItems((cur) => (cursor && cur ? [...cur, ...page.items] : page.items));
          setNext(page.nextCursor);
          // Salon choices remembered from what has been seen, so filtering by one salon keeps the others listed.
          setSalonNames((cur) => {
            const known = new Map(cur);
            for (const inv of page.items) if (inv.salonName) known.set(inv.salonId, inv.salonName);
            return known.size === cur.size ? cur : known;
          });
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your invoices."));
    },
    [query],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setItems(null);
      setError(null);
      void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Payment status is derived from recorded payments, so it is filtered on the loaded invoices.
  const shown = useMemo(() => (items ?? []).filter((inv) => !payment || inv.paymentStatus === payment), [items, payment]);

  async function download(invoice: InvoiceSummaryDto) {
    setBusyId(invoice.id);
    setError(null);
    try {
      const { blob, filename } = await apiFetchBlob(`invoices/mine/${invoice.id}/pdf`);
      triggerBlobDownload(blob, filename ?? `${invoice.number}.pdf`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this invoice.");
    } finally {
      setBusyId(null);
    }
  }

  async function view(invoice: InvoiceSummaryDto) {
    setBusyId(invoice.id);
    try {
      setDetail(await apiFetch<InvoiceDetailDto>(`invoices/mine/${invoice.id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open this invoice.");
    } finally {
      setBusyId(null);
    }
  }

  const filtersActive = !!(range || appliedQ || payment || salon);

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>My Invoices</h1>
          <p className={styles.sub}>Invoices salons have issued to you for completed services.</p>
        </div>
      </div>

      <div className={styles.filters} aria-label="Filter invoices">
        <form
          className={styles.field}
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedQ(q.trim());
          }}
        >
          Invoice number
          <input type="search" value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} onBlur={() => setAppliedQ(q.trim())} placeholder="e.g. INV-0012" />
        </form>
        <label className={styles.field}>
          Date
          <select value={range} onChange={(e) => setRange(e.target.value as DateRangePreset | "")}>
            <option value="">Any time</option>
            {DATE_RANGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Salon
          <select value={salon} onChange={(e) => setSalon(e.target.value)}>
            <option value="">All salons</option>
            {[...salonNames.entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Payment
          <select value={payment} onChange={(e) => setPayment(e.target.value)}>
            <option value="">Any status</option>
            {CUSTOMER_INVOICE_PAYMENT_FILTERS.map((s) => <option key={s} value={s}>{STATUS[s]?.label ?? s}</option>)}
          </select>
        </label>
        {filtersActive && (
          <button type="button" className={styles.btnGhost} onClick={() => { setRange(""); setQ(""); setAppliedQ(""); setPayment(""); setSalon(""); }}>
            Clear filters
          </button>
        )}
      </div>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {items === null && !error && <div className={styles.list} aria-busy="true">{[0, 1].map((i) => <div key={i} className={styles.skeleton} style={{ height: 80 }} />)}</div>}
      {items && shown.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><DashIcon name="invoice" size={26} /></span>
          <h2>{filtersActive ? "No invoices match these filters" : "Your issued invoices will appear here."}</h2>
          <p>{filtersActive ? "Try a wider date range or clear the filters." : "A salon issues an invoice after your service is complete. Visits without one show “Invoice not available” in My Appointments."}</p>
        </div>
      )}

      <div className={styles.list}>
        {shown.map((inv) => {
          const status = STATUS[inv.paymentStatus] ?? { label: inv.paymentStatus, tone: "" };
          return (
            <article key={inv.id} className={styles.card}>
              <div className={styles.cardHead} style={{ marginBottom: 0, flexWrap: "wrap" }}>
                <div className={styles.rowMain}>
                  <h2 className={styles.rowTitle}>{inv.number}</h2>
                  <p className={styles.meta}>
                    {inv.salonName ? `Issued by ${inv.salonName} · ` : ""}{day(inv.issuedAt)} · Service on {day(inv.serviceDate)}
                  </p>
                  {inv.amountRefunded > 0 && <p className={styles.meta}>Refunded {formatMoney(inv.amountRefunded, inv.currency)}</p>}
                  {inv.balanceDue > 0 && <p className={styles.meta}>Balance due {formatMoney(inv.balanceDue, inv.currency)}</p>}
                </div>
                <div className={styles.actions}>
                  <span className={`${styles.badge} ${status.tone}`}>{status.label}</span>
                  <strong className={styles.amount}>{formatMoney(inv.total, inv.currency)}</strong>
                  <button type="button" className={styles.btn} disabled={busyId === inv.id} onClick={() => void view(inv)}>Details</button>
                  <button type="button" className={styles.btnPrimary} disabled={busyId === inv.id} onClick={() => void download(inv)}>
                    {busyId === inv.id ? "Preparing…" : "Download PDF"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
      {next && <div><button type="button" className={styles.btn} onClick={() => void load(next)}>Load more</button></div>}

      {detail && <InvoiceDetail invoice={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function InvoiceDetail({ invoice, onClose }: { invoice: InvoiceDetailDto; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Invoice ${invoice.number}`}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(26,21,51,.45)", display: "grid", placeItems: "center", padding: 16 }}
    >
      <div className={styles.card} onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 100%)", maxHeight: "calc(100dvh - 32px)", overflowY: "auto" }}>
        <div className={styles.cardHead}>
          <h2 className={styles.sectionTitle}>Invoice {invoice.number}</h2>
          <button type="button" className={styles.btn} onClick={onClose} autoFocus>Close</button>
        </div>
        <p className={styles.meta}>
          Issued by {invoice.seller.legalName || invoice.salonName} on {day(invoice.issuedAt)}
          {invoice.seller.gstin ? ` · GSTIN ${invoice.seller.gstin}` : ""}
        </p>
        {invoice.seller.address && <p className={styles.meta}>{invoice.seller.address}</p>}
        {invoice.staffName && <p className={styles.meta}>Served by {invoice.staffName}</p>}
        {invoice.lines.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0", display: "grid", gap: 6 }}>
            {invoice.lines.map((l) => (
              <li key={l.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span>{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ""}</span>
                <span>{formatMoney(l.lineTotal, invoice.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 12px", margin: "12px 0 0" }}>
          <dt>Subtotal</dt><dd style={{ margin: 0 }}>{formatMoney(invoice.subtotal, invoice.currency)}</dd>
          {invoice.discountTotal > 0 && (<><dt>Discounts</dt><dd style={{ margin: 0 }}>−{formatMoney(invoice.discountTotal, invoice.currency)}</dd></>)}
          {invoice.taxTotal > 0 && (<><dt>{invoice.taxLabel ?? "Tax"}{invoice.taxRatePercent !== null ? ` (${invoice.taxRatePercent}%)` : ""}</dt><dd style={{ margin: 0 }}>{formatMoney(invoice.taxTotal, invoice.currency)}</dd></>)}
          <dt><strong>Total</strong></dt><dd style={{ margin: 0 }}><strong>{formatMoney(invoice.total, invoice.currency)}</strong></dd>
          <dt>Paid</dt><dd style={{ margin: 0 }}>{formatMoney(invoice.amountPaid, invoice.currency)}</dd>
          {invoice.amountRefunded > 0 && (<><dt>Refunded</dt><dd style={{ margin: 0 }}>{formatMoney(invoice.amountRefunded, invoice.currency)}</dd></>)}
        </dl>
        <p className={styles.meta} style={{ marginTop: 12 }}>The PDF is the issued document; this is a summary of it.</p>
        <div className={styles.actions} style={{ marginTop: 8 }}>
          <button type="button" className={styles.btn} onClick={() => window.print()}>Print</button>
        </div>
      </div>
    </div>
  );
}
