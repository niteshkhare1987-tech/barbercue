"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  SHOP_ACCEPT_WINDOW_HOURS,
  type ShopCheckoutResultDto,
  type ShopOrderDto,
  type ShopQuoteDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { bag, newIdempotencyKey, rememberGuestOrder, useBag, useGuestOrders, type BagLine } from "../../lib/shop/store";
import { Packshot, rupees } from "./ShopParts";
import { FastQueOrders } from "../commerce/FastQueOrder";
import s from "./shop.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);

/** Live server quote for the bag (prices, stock, single-salon rule). */
function useQuote(lines: BagLine[]) {
  const [quote, setQuote] = useState<ShopQuoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = lines.map((l) => `${l.listingId}:${l.quantity}`).join(",");
  const refresh = useCallback(() => {
    if (!lines.length) return;
    apiFetch<ShopQuoteDto>("shop/cart/quote", { method: "POST", body: JSON.stringify({ items: lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity })) }) })
      .then((q) => {
        setQuote(q);
        setError(null);
      })
      .catch((err) => setError(errorText(err, "Prices could not be checked. Try again.")));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-quote when the bag's lines change
  }, [key]);
  useEffect(() => refresh(), [refresh]);
  return { quote: lines.length ? quote : null, error, refresh };
}

export function ShopBag() {
  const lines = useBag();
  const { quote, error } = useQuote(lines);
  if (!lines.length)
    return (
      <main style={{ paddingTop: 24 }}>
        <div className={s.empty}>
          <strong>Your bag is empty</strong>
          <span>Find something you’ll love — products from salons near you.</span>
          <Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Start shopping</Link>
        </div>
      </main>
    );
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="bag-title">
      <h1 id="bag-title" className={s.h2}>Your bag</h1>
      <p className={s.sub}>Collect everything from {lines[0].salonName}. Prices are checked live with the salon.</p>
      <div className={s.twoCol}>
        <section className={s.panel} aria-label="Items">
          {lines.map((l) => {
            const q = quote?.lines.find((x) => x.listingId === l.listingId);
            return (
              <div key={l.listingId} className={s.line}>
                <div className={s.thumb}><Packshot product={{ id: l.productId, name: l.name, brand: l.brand, category: l.category }} /></div>
                <div>
                  <Link href={`/shop/p/${l.productId}`} className={s.cardName} style={{ textDecoration: "none" }}>{l.name}</Link>
                  <div className={s.cardMeta}>{[l.brand, l.variant].filter(Boolean).join(" · ")} · {l.salonName}</div>
                  <div className={s.priceRow}>
                    <span className={s.price}>{rupees(q?.unitPrice ?? l.price)}</span>
                    {q?.compareAtPrice && <span className={s.strike}>{rupees(q.compareAtPrice)}</span>}
                  </div>
                  {q?.problem && <div className={`${s.alert} ${s.alertError}`} style={{ marginTop: 6, padding: "6px 10px" }}>{q.problem}</div>}
                </div>
                <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                  <div className={s.qty} aria-label={`Quantity of ${l.name}`}>
                    <button type="button" aria-label="Less" onClick={() => bag.setQuantity(l.listingId, l.quantity - 1)}>−</button>
                    <span>{l.quantity}</span>
                    <button type="button" aria-label="More" disabled={!!q && l.quantity >= Math.min(q.maxPerOrder, q.availableQuantity)} onClick={() => bag.setQuantity(l.listingId, l.quantity + 1)}>+</button>
                  </div>
                  <button type="button" className={s.more} style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => bag.remove(l.listingId)}>Remove</button>
                </div>
              </div>
            );
          })}
        </section>
        <aside className={s.panel} aria-label="Summary">
          <Totals quote={quote} />
          {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
          {quote?.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`} style={{ marginTop: 8 }}>{b}</p>)}
          <Link href="/shop/checkout" className={`${s.btn} ${s.btnPrimary} ${s.btnBlock}`} style={{ marginTop: 14, pointerEvents: quote && !quote.blocking.length ? "auto" : "none", opacity: quote && !quote.blocking.length ? 1 : 0.5 }} aria-disabled={!quote || quote.blocking.length > 0}>
            Checkout →
          </Link>
          <p className={s.cardMeta} style={{ marginTop: 10 }}>Pickup at the salon · pay at the salon. Online payment and delivery are not available yet.</p>
        </aside>
      </div>
    </main>
  );
}

function Totals({ quote }: { quote: ShopQuoteDto | null }) {
  if (!quote) return <div className={s.skel} style={{ height: 110 }} />;
  return (
    <div className={s.totals}>
      <div><span>Subtotal</span><span>{rupees(quote.subtotal)}</span></div>
      {Number(quote.savings) > 0 && <div><span>You save (salon offer)</span><span className={s.off}>{rupees(quote.savings)}</span></div>}
      {Number(quote.discountTotal) > 0 && <div><span>Discounts</span><span>−{rupees(quote.discountTotal)}</span></div>}
      <div><span>Pickup</span><span>Free</span></div>
      <div><span>Taxes</span><span>Included in salon prices</span></div>
      <div className={s.totalBig}><span>To pay at the salon</span><span>{rupees(quote.total)}</span></div>
    </div>
  );
}

export function ShopCheckout() {
  const lines = useBag();
  const router = useRouter();
  const { user } = useAuth();
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const { quote, error, refresh } = useQuote(lines);
  const keyRef = useRef<string | null>(null);
  // Fields the shopper has not typed in yet fall back to their account details.
  const [typed, setForm] = useState<{ contactName?: string; contactPhone?: string; contactEmail?: string; note?: string }>({});
  const form = {
    contactName: typed.contactName ?? "",
    contactPhone: typed.contactPhone ?? user?.phone ?? "",
    contactEmail: typed.contactEmail ?? user?.email ?? "",
    note: typed.note ?? "",
  };
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (!lines.length)
    return (
      <main style={{ paddingTop: 24 }}>
        <div className={s.empty}><strong>Nothing to check out</strong><Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Shop products</Link></div>
      </main>
    );

  async function place() {
    if (!quote || quote.blocking.length) return;
    if (form.contactName.trim().length < 2) return setSubmitError("Enter your name.");
    if (!/^\+?[0-9][0-9\s-]{7,17}$/.test(form.contactPhone.trim())) return setSubmitError("Enter a valid phone number so the salon can reach you.");
    setBusy(true);
    setSubmitError(null);
    keyRef.current ??= newIdempotencyKey(); // the same key on a retry → never a duplicate order
    try {
      const result = await apiFetch<ShopCheckoutResultDto>(isCustomer ? "customer/shop/orders" : "shop/orders", {
        method: "POST",
        headers: { "Idempotency-Key": keyRef.current },
        body: JSON.stringify({
          items: lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity })),
          contactName: form.contactName.trim(),
          contactPhone: form.contactPhone.trim(),
          contactEmail: form.contactEmail.trim() || null,
          note: form.note.trim() || null,
          fulfillment: "PICKUP",
          paymentMethod: "PAY_AT_SALON",
          expectedTotal: quote.total,
        }),
      });
      rememberGuestOrder({ orderNumber: result.order.orderNumber, token: result.accessToken, placedAt: result.order.placedAt });
      bag.clear();
      router.push(`/shop/orders/${result.order.orderNumber}?t=${encodeURIComponent(result.accessToken)}&new=1`);
    } catch (err) {
      keyRef.current = null;
      setSubmitError(errorText(err, "The order was not placed. Nothing was charged."));
      refresh();
      setBusy(false);
    }
  }

  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="co-title">
      <h1 id="co-title" className={s.h2}>Checkout</h1>
      <p className={s.sub}>{isCustomer ? "Ordering as your FastQue account." : "Guest checkout — no account needed."} You’ll collect and pay at {quote?.salon?.name ?? lines[0].salonName}.</p>
      <div className={s.twoCol}>
        <section className={s.panel} aria-label="Your details">
          <form className={s.form} onSubmit={(e) => { e.preventDefault(); void place(); }}>
            <label className={s.field}>Your name<input className={s.input} required maxLength={120} autoComplete="name" value={form.contactName} onChange={(e) => setForm({ ...typed, contactName: e.target.value })} /></label>
            <label className={s.field}>Phone (the salon may call when it’s ready)<input className={s.input} required inputMode="tel" autoComplete="tel" maxLength={20} value={form.contactPhone} onChange={(e) => setForm({ ...typed, contactPhone: e.target.value })} /></label>
            <label className={s.field}>Email (optional)<input className={s.input} type="email" autoComplete="email" maxLength={254} value={form.contactEmail} onChange={(e) => setForm({ ...typed, contactEmail: e.target.value })} /></label>
            <label className={s.field}>Note for the salon (optional)<textarea className={s.input} maxLength={300} value={form.note} onChange={(e) => setForm({ ...typed, note: e.target.value })} /></label>
            <div className={s.panel} style={{ background: "transparent" }}>
              <strong>Pickup</strong>
              <div className={s.cardMeta}>{quote?.salon ? `${quote.salon.name}${quote.salon.address ? `, ${quote.salon.address}` : ""}${quote.salon.city ? `, ${quote.salon.city}` : ""}` : "…"}</div>
              <div className={s.cardMeta} style={{ marginTop: 6 }}>The salon confirms your order within {SHOP_ACCEPT_WINDOW_HOURS} hours; until then the items are held for you.</div>
              <strong style={{ display: "block", marginTop: 10 }}>Payment</strong>
              <div className={s.cardMeta}>Pay at the salon when you collect (cash/UPI as the salon accepts). Nothing is charged online.</div>
            </div>
            {!isCustomer && <p className={s.cardMeta}>Want your orders in one place? <Link href="/login?next=/shop/checkout">Sign in</Link> first — or continue as a guest; you’ll get a private order link.</p>}
            {submitError && <p className={`${s.alert} ${s.alertError}`} role="alert">{submitError}</p>}
            <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnBlock}`} disabled={busy || !quote || quote.blocking.length > 0}>
              {busy ? "Placing order…" : quote ? `Place order · ${rupees(quote.total)}` : "Checking prices…"}
            </button>
          </form>
        </section>
        <aside className={s.panel} aria-label="Order summary">
          {lines.map((l) => {
            const q = quote?.lines.find((x) => x.listingId === l.listingId);
            return (
              <div key={l.listingId} className={s.totals} style={{ marginBottom: 8 }}>
                <div><span>{l.quantity} × {l.name}</span><span>{rupees(q?.lineTotal ?? null)}</span></div>
                {q?.problem && <span className={s.off}>{q.problem}</span>}
              </div>
            );
          })}
          <div style={{ marginTop: 12 }}><Totals quote={quote} /></div>
          {error && <p className={`${s.alert} ${s.alertError}`}>{error}</p>}
          {quote?.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`} style={{ marginTop: 8 }}>{b}</p>)}
          <Link href="/shop/bag" className={s.more} style={{ display: "inline-block", marginTop: 10 }}>← Edit bag</Link>
        </aside>
      </div>
    </main>
  );
}

/** One order: status timeline and details. Guests open it with the private link (?t=). */
export function ShopOrderView({ orderNumber, token, isNew }: { orderNumber: string; token: string | null; isNew: boolean }) {
  const { user } = useAuth();
  const guestLinks = useGuestOrders();
  const effectiveToken = token ?? guestLinks.find((o) => o.orderNumber === orderNumber)?.token ?? null;
  const [order, setOrder] = useState<ShopOrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = effectiveToken ? `shop/orders/${orderNumber}` : `customer/shop/orders/${orderNumber}`;
  const suffix = effectiveToken ? `?token=${encodeURIComponent(effectiveToken)}` : "";

  const noAccess = !effectiveToken && !user;
  useEffect(() => {
    if (noAccess) return;
    apiFetch<ShopOrderDto>(`${base}${suffix}`).then(setOrder).catch((err) => setError(errorText(err, "Order not found.")));
  }, [base, suffix, noAccess]);

  async function cancel() {
    if (!window.confirm("Cancel this order? The salon will release the items.")) return;
    setBusy(true);
    try {
      setOrder(await apiFetch<ShopOrderDto>(`${base}/cancel${suffix}`, { method: "POST", body: JSON.stringify({}) }));
    } catch (err) {
      setError(errorText(err, "The order could not be cancelled."));
    } finally {
      setBusy(false);
    }
  }

  const shownError = noAccess ? "Open this order from the link in your confirmation, or sign in." : error;
  if (shownError) return <main style={{ paddingTop: 24 }}><div className={s.empty}><strong>{shownError}</strong><Link href="/shop" className={`${s.btn} ${s.btnPrimary}`}>Back to the shop</Link></div></main>;
  if (!order) return <main style={{ paddingTop: 24 }}><div className={s.skel} style={{ height: 320 }} /></main>;
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="order-title">
      {isNew && <p className={`${s.alert} ${s.alertOk}`} role="status">🎉 Order placed! {order.salon.name} will confirm it within {SHOP_ACCEPT_WINDOW_HOURS} hours. {effectiveToken && !user ? "Bookmark this page — it is your private order link." : ""}</p>}
      <div className={s.eyebrow} style={{ marginTop: 14 }}>Order {order.orderNumber}</div>
      <h1 id="order-title" className={s.h2}>{order.statusLabel}</h1>
      <div className={s.twoCol}>
        <section className={s.panel} aria-label="Items">
          {order.items.map((i) => (
            <div key={`${i.productId}-${i.unitPrice}`} className={s.line}>
              <div className={s.thumb}><Packshot product={{ id: i.productId, name: i.name, brand: i.brand, category: null }} /></div>
              <div>
                <Link href={`/shop/p/${i.productId}`} className={s.cardName} style={{ textDecoration: "none" }}>{i.name}</Link>
                <div className={s.cardMeta}>{[i.brand, i.variant, i.barcode ? `EAN ${i.barcode}` : null].filter(Boolean).join(" · ")}</div>
              </div>
              <div style={{ textAlign: "right" }}>{i.quantity} × {rupees(i.unitPrice)}<div className={s.price}>{rupees(i.lineTotal)}</div></div>
            </div>
          ))}
          <div className={s.totals} style={{ marginTop: 10 }}>
            <div className={s.totalBig}><span>{order.paymentStatus === "PAID_AT_SALON" ? "Paid at the salon" : "To pay at the salon"}</span><span>{rupees(order.total)}</span></div>
          </div>
        </section>
        <aside className={s.panel} aria-label="Pickup and status">
          <strong>Pickup at {order.salon.name}</strong>
          <div className={s.cardMeta}>{[order.salon.address, order.salon.city].filter(Boolean).join(", ")}</div>
          {order.salon.phone && <div className={s.cardMeta}>📞 <a href={`tel:${order.salon.phone}`}>{order.salon.phone}</a></div>}
          <ul className={s.timeline}>
            {order.events.map((e, n) => (
              <li key={n}><span><strong style={{ color: "var(--s-text)" }}>{e.toStatus.replace(/_/g, " ").toLowerCase()}</strong> · {new Date(e.at).toLocaleString()}{e.note ? ` — ${e.note}` : ""}</span></li>
            ))}
          </ul>
          {order.allowedTransitions.includes("CANCELLED") && (
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} style={{ marginTop: 14 }} disabled={busy} onClick={() => void cancel()}>Cancel order</button>
          )}
          <p className={s.cardMeta} style={{ marginTop: 14 }}>Booked for {order.contactName} · {order.contactPhone}</p>
        </aside>
      </div>
    </main>
  );
}

/** Orders on this device (guest links) plus the signed-in customer's account orders. */
export function ShopOrdersList() {
  const { user } = useAuth();
  const links = useGuestOrders();
  const [mine, setMine] = useState<ShopOrderDto[] | null>(null);
  useEffect(() => {
    if (user?.roles.includes("CUSTOMER")) apiFetch<ShopOrderDto[]>("customer/shop/orders").then(setMine).catch(() => setMine([]));
  }, [user]);
  const accountNumbers = new Set((mine ?? []).map((o) => o.orderNumber));
  const deviceOnly = links.filter((l) => !accountNumbers.has(l.orderNumber));
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="orders-title">
      <h1 id="orders-title" className={s.h2}>My orders</h1>
      <FastQueOrders />
      {!user && <p className={s.sub}>Guest orders placed on this device are listed here. <Link href="/login?next=/shop/orders">Sign in</Link> to see orders on your account.</p>}
      <div className={s.offers}>
        {(mine ?? []).map((o) => (
          <Link key={o.id} href={`/shop/orders/${o.orderNumber}`} className={s.offer} style={{ textDecoration: "none" }}>
            <div><h4>{o.orderNumber} · {o.salon.name}</h4><div className={s.cardMeta}>{new Date(o.placedAt).toLocaleString()} · {o.items.length} item{o.items.length === 1 ? "" : "s"}</div></div>
            <div style={{ textAlign: "right" }}><div className={s.price}>{rupees(o.total)}</div><span className={s.cardMeta}>{o.statusLabel}</span></div>
          </Link>
        ))}
        {deviceOnly.map((l) => (
          <Link key={l.orderNumber} href={`/shop/orders/${l.orderNumber}?t=${encodeURIComponent(l.token)}`} className={s.offer} style={{ textDecoration: "none" }}>
            <div><h4>{l.orderNumber}</h4><div className={s.cardMeta}>Guest order · {new Date(l.placedAt).toLocaleString()}</div></div>
            <span className={s.more}>Track →</span>
          </Link>
        ))}
        {mine !== null && !mine.length && !deviceOnly.length && <div className={s.empty}><strong>No orders yet</strong><Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Start shopping</Link></div>}
        {!user && !deviceOnly.length && <div className={s.empty}><strong>No orders on this device</strong><Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Start shopping</Link></div>}
      </div>
    </main>
  );
}
