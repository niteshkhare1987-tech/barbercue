"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommerceAddressInput, CommerceCheckoutResultDto, CommerceQuoteDto, ShopQuoteDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { bag, newIdempotencyKey, rememberGuestOrder, useBag, type BagLine } from "../../lib/shop/store";
import { fqBag, rememberFqOrder, setFqPin, useCommerceConfig, useFqBag, useFqPin, useFqSaved } from "../../lib/commerce/store";
import { ShopBag } from "../shop/ShopCheckout";
import { Packshot, rupees } from "../shop/ShopParts";
import { errText, PinCheck } from "./CommerceParts";
import { countPage } from "./FastQueExtras";
import s from "../shop/shop.module.css";
import c from "./commerce.module.css";

function useFqQuote(pincode: string, couponCode: string) {
  const lines = useFqBag();
  const [quote, setQuote] = useState<CommerceQuoteDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = lines.map((l) => `${l.listingId}:${l.quantity}`).join(",");
  const refresh = useCallback(() => {
    if (!key) return;
    const items = key.split(",").map((x) => ({ listingId: x.split(":")[0], quantity: Number(x.split(":")[1]) }));
    apiFetch<CommerceQuoteDto>("commerce/quote", {
      method: "POST",
      body: JSON.stringify({ items, ...(/^[1-9]\d{5}$/.test(pincode) ? { pincode } : {}), ...(couponCode ? { couponCode } : {}) }),
    })
      .then((q) => {
        setQuote(q);
        setError(null);
      })
      .catch((e) => setError(errText(e, "Prices could not be checked. Try again.")));
  }, [key, pincode, couponCode]);
  useEffect(() => refresh(), [refresh]);
  return { lines, quote: key ? quote : null, error, refresh };
}

const bySalon = (lines: BagLine[]) => {
  const m = new Map<string, BagLine[]>();
  for (const l of lines) m.set(l.salonId, [...(m.get(l.salonId) ?? []), l]);
  return [...m.values()];
};
function useSalonQuotes(lines: BagLine[]) {
  const [quotes, setQuotes] = useState<Record<string, ShopQuoteDto | string>>({});
  const key = JSON.stringify(bySalon(lines).map((g) => [g[0].salonId, g.map((l) => [l.listingId, l.quantity])]));
  const refresh = useCallback(() => {
    for (const [salonId, items] of JSON.parse(key) as Array<[string, Array<[string, number]>]>)
      apiFetch<ShopQuoteDto>("shop/cart/quote", { method: "POST", body: JSON.stringify({ items: items.map(([listingId, quantity]) => ({ listingId, quantity })) }) })
        .then((q) => setQuotes((x) => ({ ...x, [salonId]: q })))
        .catch((e) => setQuotes((x) => ({ ...x, [salonId]: errText(e, "Could not check this salon.") })));
  }, [key]);
  useEffect(() => refresh(), [refresh]);
  return { quotes, refresh };
}

const couponPart = (q: CommerceQuoteDto) => Number(q.discountTotal) - (q.promotions ?? []).reduce((n, p) => n + Number(p.amount), 0);
function Totals({ q }: { q: CommerceQuoteDto }) {
  return (
    <div className={s.totals}>
      <div><span>Products</span><span>{rupees(q.subtotal)}</span></div>
      {q.promotions?.map((p) => <div key={p.name}><span>{p.name}</span><span className={s.off}>−{rupees(p.amount)}</span></div>)}
      {couponPart(q) > 0 && <div><span>Coupon {q.couponCode}</span><span className={s.off}>−{rupees(couponPart(q))}</span></div>}
      <div><span>Delivery</span><span>{q.deliveryCharge == null ? "Enter PIN" : Number(q.deliveryCharge) === 0 ? "Free" : rupees(q.deliveryCharge)}</span></div>
      <div><span>GST included</span><span>{rupees(q.taxIncluded)}</span></div>
      <div className={s.totalBig}><span>Pay on delivery</span><span>{rupees(q.total)}</span></div>
    </div>
  );
}

/** The bag page: exactly the existing salon bag while direct commerce is off. */
export function BagSwitch() {
  const cfg = useCommerceConfig();
  const fq = useFqBag();
  const saved = useFqSaved();
  if (!cfg.enabled || (!fq.length && !saved.length && bySalonCount() < 2)) return <ShopBag />;
  return <UnifiedBag />;
}
const bySalonCount = () => (typeof window === "undefined" ? 0 : bySalon(bag.get()).length);

function UnifiedBag() {
  const cfg = useCommerceConfig();
  const pin = useFqPin();
  const saved = useFqSaved();
  const salons = useBag();
  const { lines, quote, error } = useFqQuote(pin, "");
  const groups = bySalon(salons);
  const { quotes } = useSalonQuotes(salons);
  useEffect(() => countPage("BAG_VIEW"), []);
  const mixed = groups.length > 1 || (lines.length > 0 && groups.length > 0);
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="bag-title">
      <h1 id="bag-title" className={s.h2}>Your bag</h1>
      <p className={s.sub}>{mixed ? "Each seller sends or hands over its own products, and is paid separately." : "Prices and stock are checked live."}</p>
      {lines.length > 0 && (
        <section className={c.group} aria-label="FastQue products">
          <div className={c.groupHead}>
            <h2>🚚 Delivered by FastQue</h2>
            <span className={s.cardMeta}>Home delivery · Cash on Delivery</span>
          </div>
          {lines.map((l) => {
            const q = quote?.lines.find((x) => x.listingId === l.listingId);
            return (
              <div key={l.listingId} className={s.line}>
                <div className={s.thumb}><Packshot product={{ id: l.productId, name: l.name, brand: l.brand, category: l.category, imageUrl: l.imageUrl }} /></div>
                <div>
                  <Link href={`/shop/p/${l.productId}`} className={s.cardName} style={{ textDecoration: "none" }}>{l.name}</Link>
                  <div className={s.cardMeta}>{[l.brand, l.variant].filter(Boolean).join(" · ")} · Sold by FastQue</div>
                  <div className={s.priceRow}><span className={s.price}>{rupees(q?.unitPrice ?? l.price)}</span></div>
                  {q?.problem && <div className={`${s.alert} ${s.alertError}`}>{q.problem}</div>}
                </div>
                <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                  <div className={s.qty} aria-label={`Quantity of ${l.name}`}>
                    <button type="button" aria-label="Less" onClick={() => fqBag.setQuantity(l.listingId, l.quantity - 1)}>−</button>
                    <span>{l.quantity}</span>
                    <button type="button" aria-label="More" disabled={!!q && l.quantity >= q.availableQuantity} onClick={() => fqBag.setQuantity(l.listingId, l.quantity + 1)}>+</button>
                  </div>
                  <button type="button" className={s.more} style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => fqBag.saveForLater(l)}>Save for later</button>
                  <button type="button" className={s.more} style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => fqBag.remove(l.listingId)}>Remove</button>
                </div>
              </div>
            );
          })}
          <PinCheck />
          {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
          {quote && <Totals q={quote} />}
          {quote?.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`}>{b}</p>)}
          {(!mixed || !cfg.multiSellerCart) && <Link href="/shop/fastque/checkout" className={`${s.btn} ${s.btnPrimary}`}>Checkout FastQue products →</Link>}
        </section>
      )}
      {groups.map((g) => {
        const q = quotes[g[0].salonId];
        return (
          <section key={g[0].salonId} className={c.group} aria-label={g[0].salonName}>
            <div className={c.groupHead}>
              <h2>💈 Pick up at {g[0].salonName}</h2>
              <span className={s.cardMeta}>Salon pickup · Pay at salon</span>
            </div>
            {g.map((l) => (
              <div key={l.listingId} className={s.row} style={{ justifyContent: "space-between" }}>
                <span>{l.quantity} × {l.name}</span>
                <span className={s.row}>
                  {rupees(Number(l.price) * l.quantity)}
                  <button type="button" className={s.more} style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => bag.remove(l.listingId)}>Remove</button>
                </span>
              </div>
            ))}
            {typeof q === "string" && <p className={`${s.alert} ${s.alertError}`}>{q}</p>}
            {q && typeof q !== "string" && (
              <>
                {q.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`}>{b}</p>)}
                <strong>Pay at salon: {rupees(q.total)}</strong>
              </>
            )}
            {!cfg.multiSellerCart && groups.length === 1 && <Link href="/shop/checkout" className={`${s.btn} ${s.btnGhost}`}>Checkout this salon →</Link>}
          </section>
        );
      })}
      {cfg.multiSellerCart && mixed && (
        <>
          <p className={s.sub}>One checkout places {groups.length + (lines.length ? 1 : 0)} separate orders. If any seller cannot supply, nothing is ordered.</p>
          <Link href="/shop/fastque/checkout" className={`${s.btn} ${s.btnPrimary} ${s.btnBlock}`}>Checkout everything →</Link>
        </>
      )}
      {saved.length > 0 && (
        <section className={c.group} aria-label="Saved for later">
          <h2>Saved for later</h2>
          {saved.map((l) => (
            <div key={l.listingId} className={s.row} style={{ justifyContent: "space-between" }}>
              <span>{l.name}</span>
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => fqBag.moveToBag(l)}>Move to bag</button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

type SavedAddress = CommerceAddressInput & { id: string };
const BLANK = { name: "", phone: "", line1: "", line2: "", landmark: "", city: "", state: "", pincode: "" };

/** Delivery checkout (Cash on Delivery), optionally together with salon pickups. */
export function FastQueCheckout() {
  const cfg = useCommerceConfig();
  const router = useRouter();
  const { user } = useAuth();
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const remembered = useFqPin();
  const salonLines = useBag();
  const [typed, setTyped] = useState<Partial<typeof BLANK>>({});
  const [email, setEmail] = useState("");
  const [instructions, setInstructions] = useState("");
  const [coupon, setCoupon] = useState("");
  const [applied, setApplied] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [billing, setBilling] = useState<typeof BLANK | null>(null);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const f = { ...BLANK, phone: user?.phone ?? "", pincode: remembered, ...typed };
  const { lines, quote, error, refresh } = useFqQuote(f.pincode, applied);
  const groups = cfg.multiSellerCart ? bySalon(salonLines) : [];
  const { quotes, refresh: refreshSalons } = useSalonQuotes(cfg.multiSellerCart ? salonLines : []);

  useEffect(() => {
    if (cfg.enabled) countPage("CHECKOUT_START");
  }, [cfg.enabled]);
  useEffect(() => {
    if (cfg.enabled && isCustomer) apiFetch<SavedAddress[]>("customer/commerce/addresses").then(setAddresses).catch(() => undefined);
  }, [cfg.enabled, isCustomer]);

  if (!cfg.enabled || (!lines.length && !groups.length))
    return (
      <main style={{ paddingTop: 24 }}>
        <div className={s.empty}><strong>Nothing to check out</strong><Link href="/shop/fastque" className={`${s.btn} ${s.btnPrimary}`}>Shop from FastQue</Link></div>
      </main>
    );
  const set = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => setTyped({ ...typed, [k]: e.target.value });
  const salonsReady = groups.every((g) => {
    const q = quotes[g[0].salonId];
    return q && typeof q !== "string" && !q.blocking.length;
  });
  const fqReady = !lines.length || (!!quote && !quote.blocking.length && !!quote.serviceability?.serviceable);
  const ready = fqReady && salonsReady;

  async function place() {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    keyRef.current ??= newIdempotencyKey();
    const address = { name: f.name.trim(), phone: f.phone.trim(), line1: f.line1.trim(), line2: f.line2.trim() || null, landmark: f.landmark.trim() || null, city: f.city.trim(), state: f.state.trim(), pincode: f.pincode };
    try {
      const r = await apiFetch<CommerceCheckoutResultDto>(isCustomer ? "customer/commerce/checkout" : "commerce/checkout", {
        method: "POST",
        headers: { "Idempotency-Key": keyRef.current },
        body: JSON.stringify({
          contactName: address.name,
          contactPhone: address.phone,
          contactEmail: email.trim() || null,
          ...(lines.length
            ? {
                fastque: {
                  items: lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity })),
                  address,
                  ...(billing ? { billingAddress: { ...billing, phone: billing.phone || address.phone, line2: billing.line2 || null, landmark: billing.landmark || null } } : {}),
                  instructions: instructions.trim() || null,
                  ...(quote!.couponCode ? { couponCode: quote!.couponCode } : {}),
                  expectedTotal: quote!.total,
                },
              }
            : {}),
          salons: groups.map((g) => ({ items: g.map((l) => ({ listingId: l.listingId, quantity: l.quantity })), expectedTotal: (quotes[g[0].salonId] as ShopQuoteDto).total })),
        }),
      });
      const placedAt = new Date().toISOString();
      if (r.fastque) rememberFqOrder({ orderNumber: r.fastque.orderNumber, token: r.fastque.accessToken, placedAt });
      r.salons.forEach((o) => rememberGuestOrder({ orderNumber: o.orderNumber, token: o.accessToken, placedAt }));
      if (lines.length) setFqPin(f.pincode);
      if (isCustomer && saveAddress) await apiFetch("customer/commerce/addresses", { method: "POST", body: JSON.stringify(address) }).catch(() => undefined);
      fqBag.clear();
      if (groups.length) bag.clear();
      router.push(r.fastque ? `/shop/delivery/${r.fastque.orderNumber}?t=${encodeURIComponent(r.fastque.accessToken)}&new=1` : "/shop/orders");
    } catch (e) {
      keyRef.current = null;
      setProblem(errText(e, "The order was not placed. Nothing was charged."));
      refresh();
      refreshSalons();
      setBusy(false);
    }
  }
  const field = (k: keyof typeof BLANK, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}, wide = false) => (
    <label className={`${s.field} ${wide ? c.wide : ""}`}>
      {label}
      <input className={s.input} value={f[k]} onChange={set(k)} {...extra} />
    </label>
  );
  return (
    <main style={{ paddingTop: 20 }} aria-labelledby="dc-title">
      <h1 id="dc-title" className={s.h2}>Checkout</h1>
      <p className={s.sub}>{isCustomer ? "Ordering with your FastQue account." : "Guest checkout. You will get a private order link."}</p>
      <div className={s.twoCol}>
        <form className={s.panel} aria-label="Your details" onSubmit={(e) => { e.preventDefault(); void place(); }}>
          {lines.length > 0 && addresses.length > 0 && (
            <label className={s.field}>
              Saved addresses
              <select className={s.select} defaultValue="" onChange={(e) => { const a = addresses.find((x) => x.id === e.target.value); if (a) setTyped({ name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 ?? "", landmark: a.landmark ?? "", city: a.city, state: a.state, pincode: a.pincode }); }}>
                <option value="">Choose…</option>
                {addresses.map((a) => <option key={a.id} value={a.id}>{a.label ?? a.line1}, {a.city} {a.pincode}</option>)}
              </select>
            </label>
          )}
          <div className={c.formGrid}>
            {field("name", "Full name", { required: true, minLength: 2, autoComplete: "name" })}
            {field("phone", "Mobile number", { required: true, inputMode: "tel", autoComplete: "tel" })}
            <label className={`${s.field} ${c.wide}`}>Email (optional)<input className={s.input} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            {lines.length > 0 && (
              <>
                {field("line1", "House / flat and street", { required: true, minLength: 3, autoComplete: "address-line1" }, true)}
                {field("line2", "Area (optional)", { autoComplete: "address-line2" })}
                {field("landmark", "Landmark (optional)")}
                {field("city", "City", { required: true, minLength: 2, autoComplete: "address-level2" })}
                {field("state", "State", { required: true, minLength: 2, autoComplete: "address-level1" })}
                {field("pincode", "PIN code", { required: true, inputMode: "numeric", maxLength: 6, pattern: "[1-9][0-9]{5}", autoComplete: "postal-code" })}
                <label className={s.field}>Delivery instructions (optional)<input className={s.input} maxLength={300} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></label>
                <label className={`${s.check} ${c.wide}`}><input type="checkbox" checked={!!billing} onChange={(e) => setBilling(e.target.checked ? { ...BLANK, name: f.name } : null)} /> Bill to a different address</label>
                {billing && (["name", "line1", "city", "state", "pincode"] as const).map((k) => <label key={k} className={s.field}>Billing {k === "line1" ? "street" : k === "pincode" ? "PIN code" : k}<input className={s.input} required minLength={2} {...(k === "pincode" ? { pattern: "[1-9][0-9]{5}", inputMode: "numeric" as const, maxLength: 6 } : {})} value={billing[k]} onChange={(e) => setBilling({ ...billing, [k]: e.target.value })} /></label>)}
                {isCustomer && <label className={`${s.check} ${c.wide}`}><input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} /> Save this address</label>}
              </>
            )}
          </div>
          <div className={s.panel} style={{ background: "transparent", marginTop: 12 }}>
            <strong>Payment</strong>
            {lines.length > 0 && <div className={s.cardMeta}>FastQue: Cash on Delivery. Nothing is charged online.</div>}
            {groups.length > 0 && <div className={s.cardMeta}>Salons: pay at each salon when you collect.</div>}
            {lines.length > 0 && <div className={s.cardMeta}>You can cancel until the parcel is packed. {cfg.seller?.returnPolicy ?? "Return eligibility is shown on each product."}</div>}
          </div>
          {problem && <p className={`${s.alert} ${s.alertError}`} role="alert">{problem}</p>}
          <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnBlock}`} style={{ marginTop: 12 }} disabled={busy || !ready}>
            {busy ? "Placing order…" : lines.length && quote ? `Place order · ${rupees(quote.total)} on delivery` : "Place orders"}
          </button>
        </form>
        <aside className={s.panel} aria-label="Order summary">
          {lines.length > 0 && (
            <section className={c.group}>
              <strong>🚚 FastQue delivery</strong>
              {lines.map((l) => <div key={l.listingId} className={s.cardMeta}>{l.quantity} × {l.name}</div>)}
              <div className={s.row}>
                <input className={s.input} aria-label="Coupon code" placeholder="Coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => setApplied(coupon.trim())}>Apply</button>
              </div>
              {applied && quote?.couponMessage && <span className={quote.couponCode ? c.good : c.bad}>{quote.couponMessage}</span>}
              {error && <p className={`${s.alert} ${s.alertError}`}>{error}</p>}
              {quote && <Totals q={quote} />}
              {quote?.serviceability?.serviceable && <span className={c.good}>{quote.serviceability.message}</span>}
              {quote?.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`}>{b}</p>)}
            </section>
          )}
          {groups.map((g) => {
            const q = quotes[g[0].salonId];
            return (
              <section key={g[0].salonId} className={c.group}>
                <strong>💈 {g[0].salonName} · pickup</strong>
                {g.map((l) => <div key={l.listingId} className={s.cardMeta}>{l.quantity} × {l.name}</div>)}
                {typeof q === "string" ? <p className={`${s.alert} ${s.alertError}`}>{q}</p> : q ? <>{q.blocking.map((b) => <p key={b} className={`${s.alert} ${s.alertError}`}>{b}</p>)}<span>Pay at salon {rupees(q.total)}</span></> : null}
              </section>
            );
          })}
          <Link href="/shop/bag" className={s.more}>← Edit bag</Link>
        </aside>
      </div>
    </main>
  );
}
