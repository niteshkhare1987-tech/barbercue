"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { COMMERCE_RETURN_REASONS, COMMERCE_STATUS_LABEL, COMMERCE_TIMELINE, type CommerceOrderDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { rememberFqOrder, useCommerceConfig, useFqOrders } from "../../lib/commerce/store";
import { rupees } from "../shop/ShopParts";
import { errText } from "./CommerceParts";
import { OrderExtras, SavedAddresses } from "./FastQueExtras";
import s from "../shop/shop.module.css";
import c from "./commerce.module.css";

const REASON: Record<string, string> = { WRONG_PRODUCT: "Wrong product", DAMAGED: "Damaged", MISSING: "Missing from the parcel", EXPIRED: "Expired", DEFECTIVE: "Defective", OTHER: "Other" };
const when = (v: string) => new Date(v).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const day = (v: string) => new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** One FastQue order: delivery timeline, amounts, cancel, returns. Guests use the private link (?t=). */
export function FastQueOrder({ orderNumber }: { orderNumber: string }) {
  const cfg = useCommerceConfig();
  const { user, status } = useAuth();
  const params = useSearchParams();
  const links = useFqOrders();
  const urlToken = params.get("t");
  const token = urlToken ?? links.find((l) => l.orderNumber === orderNumber)?.token ?? null;
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const [order, setOrder] = useState<CommerceOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const base = token ? `commerce/orders/${orderNumber}` : `customer/commerce/orders/${orderNumber}`;
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const load = useCallback(() => {
    if (!cfg.enabled || status === "loading" || (!token && !isCustomer)) return;
    apiFetch<CommerceOrderDto>(`${base}${suffix}`).then(setOrder).catch((e) => setError(errText(e, "The order could not be loaded.")));
  }, [cfg.enabled, status, token, isCustomer, base, suffix]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    if (urlToken && order && !links.some((l) => l.orderNumber === orderNumber)) rememberFqOrder({ orderNumber, token: urlToken, placedAt: order.placedAt });
  }, [urlToken, order, links, orderNumber]);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      setOrder(await apiFetch<CommerceOrderDto>(`${base}/${path}${suffix}`, { method: "POST", body: JSON.stringify(body) }));
      setReturning(false);
    } catch (e) {
      setError(errText(e, "That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  }
  if (!order)
    return (
      <main style={{ paddingTop: 24 }}>
        {error ? (
          <div className={s.empty}><strong>{error}</strong></div>
        ) : status !== "loading" && !token && !isCustomer ? (
          <div className={s.empty}><strong>Sign in to see this order</strong><Link className={`${s.btn} ${s.btnPrimary}`} href={`/login?next=/shop/delivery/${orderNumber}`}>Sign in</Link></div>
        ) : (
          <div className={s.skel} style={{ height: 240 }} />
        )}
      </main>
    );
  const reached = new Map(order.events.map((e) => [e.toStatus, e.at]));
  const ended = ["CANCELLED", "RETURN_TO_ORIGIN", "RETURNED", "DELIVERY_FAILED"].includes(order.status);
  const steps = COMMERCE_TIMELINE.filter((x) => !ended || reached.has(x));
  const canReturn = cfg.returns && order.status === "DELIVERED" && order.items.some((i) => i.returnableQuantity > 0 && i.returnableUntil && new Date(i.returnableUntil) > new Date());
  const a = order.shippingAddress;
  const couponPart = Number(order.discountTotal) - (order.promotions ?? []).reduce((n, p) => n + Number(p.amount), 0);
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="o-title">
      {params.get("new") && <p className={`${s.alert} ${s.alertOk}`} role="status">Order placed. Pay {rupees(order.total)} in cash when it arrives.</p>}
      <h1 id="o-title" className={s.h2}>{order.orderNumber}</h1>
      <p className={s.sub}>Sold by {order.sellerName} · Home delivery · {order.paymentLabel}</p>
      {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
      <div className={s.twoCol}>
        <section className={s.panel} aria-label="Delivery">
          <strong>{order.statusLabel}</strong>
          {!ended && order.status !== "DELIVERED" && <p className={s.cardMeta}>Expected {day(order.expectedFrom)} – {day(order.expectedTo)}</p>}
          <ol className={c.timeline} style={{ marginTop: 12 }}>
            {steps.map((x) => (
              <li key={x} className={reached.has(x) ? c.done : ""}><span>{COMMERCE_STATUS_LABEL[x]}{reached.has(x) ? ` · ${when(reached.get(x)!)}` : ""}</span></li>
            ))}
            {ended && <li className={c.done}><span>{order.statusLabel}{order.cancelReason ? ` · ${order.cancelReason}` : ""}</span></li>}
          </ol>
          {order.shipment && (
            <p className={s.cardMeta} style={{ marginTop: 12 }}>
              {order.shipment.courier}{order.shipment.trackingNumber ? ` · ${order.shipment.trackingNumber}` : ""}
              {order.shipment.trackingUrl && <> · <a href={order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer">Track ↗</a></>}
              {order.shipment.manual && <> · Updates are recorded by FastQue staff</>}
            </p>
          )}
          <p className={s.cardMeta} style={{ marginTop: 12 }}>To {a.name}, {[a.line1, a.line2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).join(", ")}</p>
          <div className={`${s.row} ${c.noPrint}`} style={{ marginTop: 12 }}>
            {order.allowedTransitions.includes("CANCELLED") && <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={busy} onClick={() => void act("cancel", {})}>Cancel order</button>}
            {canReturn && <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => setReturning(!returning)}>Return or replace</button>}
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => window.print()}>Print</button>
          </div>
          {returning && <ReturnForm order={order} busy={busy} onSubmit={(b) => void act("returns", b)} />}
          {order.returns.map((r) => (
            <div key={r.id} className={c.group} style={{ marginTop: 12 }}>
              <strong>Return {r.number}: {r.status.toLowerCase()}</strong>
              <span className={s.cardMeta}>{REASON[r.reason]} · {r.resolution.toLowerCase()}{r.adminNote ? ` · ${r.adminNote}` : ""}</span>
            </div>
          ))}
        </section>
        <aside className={s.panel} aria-label="Items and amounts">
          {order.items.map((i) => (
            <div key={i.id} className={s.row} style={{ justifyContent: "space-between" }}>
              <Link href={`/shop/p/${i.productId}`}>{i.quantity} × {i.name}</Link>
              <span>{rupees(i.lineTotal)}</span>
            </div>
          ))}
          <div className={s.totals} style={{ marginTop: 12 }}>
            <div><span>Products</span><span>{rupees(order.subtotal)}</span></div>
            {order.promotions?.map((p) => <div key={p.name}><span>{p.name}</span><span>−{rupees(p.amount)}</span></div>)}
            {couponPart > 0 && <div><span>Coupon {order.couponCode}</span><span>−{rupees(couponPart)}</span></div>}
            <div><span>Delivery</span><span>{Number(order.deliveryCharge) ? rupees(order.deliveryCharge) : "Free"}</span></div>
            <div><span>GST included</span><span>{rupees(order.taxIncluded)}</span></div>
            <div className={s.totalBig}><span>Total</span><span>{rupees(order.total)}</span></div>
            {Number(order.amountDue) > 0 && <div><span>Pay on delivery</span><span>{rupees(order.amountDue)}</span></div>}
          </div>
          <div className={c.noPrint} style={{ display: "grid", gap: 12, marginTop: 14 }}>
            <OrderExtras key={order.status + order.returns.length} base={base} suffix={suffix} order={order} />
          </div>
        </aside>
      </div>
    </main>
  );
}

function ReturnForm({ order, busy, onSubmit }: { order: CommerceOrderDto; busy: boolean; onSubmit: (b: unknown) => void }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<string>("OTHER");
  const [resolution, setResolution] = useState("REFUND");
  const [details, setDetails] = useState("");
  const items = Object.entries(qty).filter(([, n]) => n > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
  return (
    <form className={c.group} style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); onSubmit({ items, reason, resolution, details: details.trim() || null }); }}>
      {order.items.filter((i) => i.returnableQuantity > 0 && i.returnableUntil).map((i) => (
        <label key={i.id} className={s.field}>
          {i.name} (up to {i.returnableQuantity})
          <input className={s.input} type="number" min={0} max={i.returnableQuantity} value={qty[i.id] ?? 0} onChange={(e) => setQty({ ...qty, [i.id]: Number(e.target.value) })} />
        </label>
      ))}
      <label className={s.field}>Reason<select className={s.select} value={reason} onChange={(e) => setReason(e.target.value)}>{COMMERCE_RETURN_REASONS.map((r) => <option key={r} value={r}>{REASON[r]}</option>)}</select></label>
      <label className={s.field}>I would like<select className={s.select} value={resolution} onChange={(e) => setResolution(e.target.value)}><option value="REFUND">A refund</option><option value="REPLACEMENT">A replacement</option></select></label>
      <label className={s.field}>What happened?<textarea className={s.input} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} /></label>
      <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={busy || !items.length}>Request return</button>
    </form>
  );
}

/** FastQue orders in the customer dashboard and on My orders. Renders nothing while off. */
export function FastQueOrders() {
  const cfg = useCommerceConfig();
  const { user } = useAuth();
  const links = useFqOrders();
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const [orders, setOrders] = useState<CommerceOrderDto[] | null>(null);
  useEffect(() => {
    if (cfg.enabled && isCustomer) apiFetch<CommerceOrderDto[]>("customer/commerce/orders").then(setOrders).catch(() => setOrders([]));
  }, [cfg.enabled, isCustomer]);
  if (!cfg.enabled) return null;
  const guest = links.filter((l) => !orders?.some((o) => o.orderNumber === l.orderNumber));
  return (
    <section aria-label="FastQue orders" style={{ padding: 16, borderRadius: 16, border: "1px solid var(--bc-border, #e7e0d3)" }}>
      <h2 style={{ marginTop: 0 }}>FastQue orders (home delivery)</h2>
      {isCustomer && !orders && "Loading…"}
      {!orders?.length && !guest.length && <p>No FastQue orders yet. <Link href="/shop/fastque">Shop from FastQue</Link></p>}
      {orders?.map((o) => (
        <div key={o.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--bc-border, #e7e0d3)" }}>
          <div>
            <strong>{o.orderNumber}</strong> · Sold by {o.sellerName}
            <div style={{ fontSize: "0.85rem", opacity: 0.75 }}>{when(o.placedAt)} · {o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</div>
            <div style={{ fontSize: "0.85rem", fontWeight: 700 }}>{o.statusLabel} · {o.paymentLabel}</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <strong>{rupees(o.total)}</strong>
            <Link href={`/shop/delivery/${o.orderNumber}`}>Track</Link>
            {o.status === "DELIVERED" && <Link href={`/shop/p/${o.items[0]?.productId}`}>Buy again</Link>}
          </div>
        </div>
      ))}
      <SavedAddresses />
      {guest.map((l) => (
        <div key={l.orderNumber} style={{ padding: "10px 0" }}><Link href={`/shop/delivery/${l.orderNumber}`}>{l.orderNumber}</Link></div>
      ))}
    </section>
  );
}
