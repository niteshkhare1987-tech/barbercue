"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { COMMERCE_PATHS as P, Role, type ListingDto, type MarketOrderDto, type MarketplaceSupplierDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import { moneyText } from "../../../lib/inventory";
import styles from "./marketplace.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const rupees = (v: string) => moneyText(v, "INR");
type View = "suppliers" | "listings" | "orders";
type AdminListing = ListingDto & { invoiceUrl: string | null; provenanceNote: string | null };

/**
 * FastQue admin: approve suppliers before salons can see them, approve listings before anyone can
 * buy, and settle disputed salon orders. Viewers can look; only super admins / co-founders act.
 */
export function AdminMarketplace() {
  const { user } = useAuth();
  const canManage = !!user?.roles.some((r) => r === Role.PLATFORM_ADMIN || r === Role.CO_FOUNDER);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = (params.get("view") as View) || "suppliers";
  const [status, setStatus] = useState<string>("");
  const [rows, setRows] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [v, setV] = useState(0);
  const path = view === "suppliers" ? P.adminSuppliers : view === "listings" ? P.adminListings : P.adminOrders;
  const defaultStatus = view === "suppliers" ? "PENDING" : view === "listings" ? "PENDING_REVIEW" : "";
  const effective = status || defaultStatus;

  useEffect(() => {
    let cancelled = false;
    void apiFetch<unknown[]>(`admin/${path}${effective ? `?status=${effective}` : ""}`)
      .then((r) => !cancelled && (setRows(r), setError(null)))
      .catch((e) => !cancelled && setError(errorText(e, "Could not load.")));
    return () => {
      cancelled = true;
    };
  }, [path, effective, v]);

  async function review(kind: "suppliers" | "listings", id: string, action: "APPROVE" | "REJECT" | "SUSPEND") {
    const note = action === "APPROVE" ? null : window.prompt("Reason (shown to them):");
    if (action !== "APPROVE" && !note) return;
    try {
      await apiFetch(`admin/${kind === "suppliers" ? P.adminSuppliers : P.adminListings}/${id}/${P.review}`, { method: "POST", body: JSON.stringify({ action, ...(note ? { note } : {}) }) });
      setNotice(`${action === "APPROVE" ? "Approved" : action === "REJECT" ? "Rejected" : "Suspended"}.`);
      setV((x) => x + 1);
    } catch (e) {
      setError(errorText(e, "That did not work."));
    }
  }
  async function resolve(id: string, outcome: "COMPLETED" | "CANCELLED") {
    const note = window.prompt(outcome === "COMPLETED" ? "Why does the buyer keep the goods?" : "Why is the sale cancelled (goods back to the seller)?");
    if (!note) return;
    try {
      await apiFetch(`admin/${P.adminOrders}/${id}/${P.resolve}`, { method: "POST", body: JSON.stringify({ outcome, note }) });
      setNotice("Dispute settled.");
      setV((x) => x + 1);
    } catch (e) {
      setError(errorText(e, "That did not work."));
    }
  }
  const go = (next: View) => {
    setStatus("");
    setRows(null);
    router.replace(`${pathname}?view=${next}`);
  };
  const statuses = view === "suppliers" ? ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] : view === "listings" ? ["PENDING_REVIEW", "ACTIVE", "PAUSED", "REJECTED", "ENDED"] : ["", "DISPUTED", "PLACED", "COMPLETED", "CANCELLED", "EXPIRED"];

  return (
    <div className={styles.page}>
      <h1>Marketplace</h1>
      <p className={styles.sub}>Nothing reaches salons or customers until it is approved here. FastQue never takes payment or holds stock.</p>
      <div className={styles.toolbar}>
        {(["suppliers", "listings", "orders"] as View[]).map((x) => (
          <button key={x} type="button" className={x === view ? styles.tabActive : styles.tab} onClick={() => go(x)}>{x === "suppliers" ? "Suppliers" : x === "listings" ? "Listings" : "Orders & disputes"}</button>
        ))}
        <select aria-label="Status" value={effective} onChange={(e) => setStatus(e.target.value || " ")}>
          {statuses.map((s) => <option key={s || "all"} value={s}>{s ? s.toLowerCase().replace(/_/g, " ") : "all"}</option>)}
        </select>
      </div>
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {error && <p className={styles.error}>{error}</p>}
      {!rows ? <p>Loading…</p> : rows.length === 0 ? <p className={styles.sub}>Nothing here.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {view === "suppliers" && (rows as MarketplaceSupplierDto[]).map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><div className={styles.sub}>{[s.legalName, s.gstin ? `GSTIN ${s.gstin}` : null].filter(Boolean).join(" · ")}</div></td>
                  <td>{s.contactName}<div className={styles.sub}>{s.phone} · {s.email}</div></td>
                  <td>{s.cityName}<div className={styles.sub}>{s.address}</div></td>
                  <td>{s.defaultLeadTimeDays} days · delivery {rupees(s.deliveryCharge)}<div className={styles.sub}>{s.offerCount} prices · {s.status.toLowerCase()}{s.reviewNote ? ` · ${s.reviewNote}` : ""}</div></td>
                  <td>{canManage && s.status === "PENDING" && <><button type="button" onClick={() => void review("suppliers", s.id, "APPROVE")}>Approve</button> <button type="button" onClick={() => void review("suppliers", s.id, "REJECT")}>Reject</button></>}
                    {canManage && s.status === "APPROVED" && <button type="button" onClick={() => void review("suppliers", s.id, "SUSPEND")}>Suspend</button>}</td>
                </tr>
              ))}
              {view === "listings" && (rows as AdminListing[]).map((l) => (
                <tr key={l.id}>
                  <td>{l.photoUrls[0] && (
                    // eslint-disable-next-line @next/next/no-img-element -- seller's stock photo
                    <img src={l.photoUrls[0]} alt="" width={56} height={56} style={{ objectFit: "cover", borderRadius: 8 }} />
                  )}</td>
                  <td><strong>{l.title}</strong><div className={styles.sub}>{l.salonName} · to {l.channel === "CUSTOMER" ? "customers" : "salons"}</div></td>
                  <td>{l.quantityListed} × {rupees(l.unitPrice)}{l.mrp ? ` (MRP ${rupees(l.mrp)})` : ""}<div className={styles.sub}>{l.expiryDate ? `expires ${l.expiryDate}` : "no expiry given"}{l.batchNumber ? ` · batch ${l.batchNumber}` : ""}</div></td>
                  <td><div className={styles.sub}>{l.provenanceNote ?? ""}{l.invoiceUrl && <> · <a href={l.invoiceUrl} target="_blank" rel="noreferrer">invoice</a></>}{l.photoUrls.length > 1 ? ` · ${l.photoUrls.length} photos` : ""}</div></td>
                  <td>{canManage && l.status === "PENDING_REVIEW" && <><button type="button" onClick={() => void review("listings", l.id, "APPROVE")}>Approve</button> <button type="button" onClick={() => void review("listings", l.id, "REJECT")}>Reject</button></>}
                    {canManage && ["ACTIVE", "PAUSED"].includes(l.status) && <button type="button" onClick={() => void review("listings", l.id, "SUSPEND")}>Take down</button>}</td>
                </tr>
              ))}
              {view === "orders" && (rows as MarketOrderDto[]).map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.number}</strong><div className={styles.sub}>{o.createdAt.slice(0, 10)} · {o.channel === "CUSTOMER" ? "customer pickup" : "salon to salon"}</div></td>
                  <td>{o.seller.name} → {o.buyer.name ?? "customer"}</td>
                  <td>{o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ")}<div className={styles.sub}>{rupees(o.total)}</div></td>
                  <td>{o.status.toLowerCase().replace(/_/g, " ")}{o.disputeReason && <div className={styles.sub}>Problem: {o.disputeReason}</div>}</td>
                  <td>{canManage && o.status === "DISPUTED" && <><button type="button" onClick={() => void resolve(o.id, "COMPLETED")}>Buyer keeps goods</button> <button type="button" onClick={() => void resolve(o.id, "CANCELLED")}>Cancel sale</button></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
