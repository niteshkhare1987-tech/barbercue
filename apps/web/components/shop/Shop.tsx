"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  COMMERCE_PATHS as P,
  DISCOVERY_PATHS,
  type CityDto,
  type ListingDto,
  type MarketOrderDto,
  type ShopProductDetailDto,
  type ShopProductDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { newIdempotencyKey } from "../../lib/idempotency";
import { moneyText } from "../../lib/inventory";
import { useAuth } from "../../lib/auth-context";
import styles from "./shop.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const rupees = (v: string) => moneyText(v, "INR");

// ---------- Cart (this browser only) ----------

export interface CartLine {
  listingId: string;
  title: string;
  salonId: string;
  salonName: string;
  unitPrice: string;
  quantity: number;
  available: number;
}
const CART_KEY = "fastque-shop-cart-v1";

export function readCart(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(CART_KEY);
    const parsed = raw ? (JSON.parse(raw) as CartLine[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function writeCart(lines: CartLine[]) {
  try {
    window.localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    /* private mode: the cart just doesn't persist */
  }
}
export function addToCart(l: ListingDto, quantity: number) {
  const lines = readCart().filter((x) => x.listingId !== l.id);
  writeCart([...lines, { listingId: l.id, title: l.title, salonId: l.salonId, salonName: l.salonName, unitPrice: l.unitPrice, quantity: Math.min(quantity, l.available), available: l.available }]);
}

// ---------- Browse ----------

/** Public: browse, search and filter products sold by FastQue salons (pickup at the salon). */
export function ShopBrowse() {
  const [cities, setCities] = useState<CityDto[]>([]);
  const [q, setQ] = useState("");
  const [cityId, setCityId] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [data, setData] = useState<{ items: ShopProductDto[]; categories: string[]; brands: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<CityDto[]>(DISCOVERY_PATHS.cities).then(setCities).catch(() => undefined);
  }, []);
  useEffect(() => {
    const params = new URLSearchParams({ limit: "48", ...(q.trim() ? { q: q.trim() } : {}), ...(cityId ? { cityId } : {}), ...(category ? { category } : {}), ...(brand ? { brand } : {}) });
    const t = setTimeout(() => {
      void apiFetch<{ items: ShopProductDto[]; categories: string[]; brands: string[] }>(`${P.shopRoot}/${P.products}?${params}`)
        .then((d) => (setData(d), setError(null)))
        .catch((e) => setError(errorText(e, "Could not load products.")));
    }, 250);
    return () => clearTimeout(t);
  }, [q, cityId, category, brand]);
  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Shop products</h1>
          <p className={styles.sub}>Genuine, sealed products from salons near you. Order now, collect at the salon and pay there.</p>
        </div>
        <div><Link href="/shop/cart" className={styles.btnQuiet}>Cart</Link> <Link href="/shop/orders" className={styles.btnQuiet}>My orders</Link></div>
      </div>
      <div className={styles.filters}>
        <input aria-label="Search products" className={styles.input} placeholder="Search by name or brand" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="City" className={styles.input} value={cityId} onChange={(e) => setCityId(e.target.value)}><option value="">All cities</option>{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select aria-label="Category" className={styles.input} value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        <select aria-label="Brand" className={styles.input} value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">All brands</option>{data?.brands.map((b) => <option key={b} value={b}>{b}</option>)}</select>
      </div>
      {error && <div className={styles.error}>{error}</div>}
      {!data ? <p className={styles.sub}>Loading…</p> : data.items.length === 0 ? <p className={styles.sub}>No products found. Try another search or city.</p> : (
        <div className={styles.grid}>
          {data.items.map((p) => (
            <Link key={p.globalProductId} href={`/shop/p/${p.globalProductId}${cityId ? `?city=${cityId}` : ""}`} className={styles.card}>
              <span className={styles.photo}>{p.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- catalog/listing photos
                <img src={p.imageUrl} alt="" />
              ) : <span aria-hidden="true">🧴</span>}</span>
              <span className={styles.name}>{p.name}</span>
              {p.brand && <span className={styles.meta}>{p.brand}</span>}
              <span className={styles.price}>{p.sellerCount > 1 ? "from " : ""}{rupees(p.lowestPrice)}{p.mrp && Number(p.mrp) > Number(p.lowestPrice) && <span className={styles.mrp}>{rupees(p.mrp)}</span>}</span>
              <span className={styles.meta}>{p.sellerCount} salon{p.sellerCount === 1 ? "" : "s"}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Public: one product, compared across the salons selling it. */
export function ShopProduct({ globalProductId, cityId }: { globalProductId: string; cityId?: string }) {
  const [data, setData] = useState<ShopProductDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<ShopProductDetailDto>(`${P.shopRoot}/${P.products}/${globalProductId}${cityId ? `?cityId=${cityId}` : ""}`)
      .then(setData)
      .catch((e) => setError(errorText(e, "Could not load this product.")));
  }, [globalProductId, cityId]);
  if (error) return <div className={styles.page}><div className={styles.error}>{error}</div><Link href="/shop">Back to the shop</Link></div>;
  if (!data) return <div className={styles.page}><p className={styles.sub}>Loading…</p></div>;
  return (
    <div className={styles.page}>
      <Link href="/shop" className={styles.meta}>← All products</Link>
      <div className={styles.head} style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span className={styles.photo} style={{ width: 160 }}>{data.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- catalog photo
            <img src={data.imageUrl} alt={data.name} />
          ) : <span aria-hidden="true">🧴</span>}</span>
          <div>
            <h1 className={styles.title}>{data.name}</h1>
            <p className={styles.sub}>{[data.brand, data.category, data.packSize ? `${Number(data.packSize)} ${data.packUnit?.toLowerCase() ?? ""}` : null].filter(Boolean).join(" · ")}</p>
            {data.mrp && <p className={styles.sub}>MRP {rupees(data.mrp)}</p>}
            {data.description && <p>{data.description}</p>}
          </div>
        </div>
      </div>
      {added && <div className={styles.ok}>Added to your cart. <Link href="/shop/cart">Go to cart</Link></div>}
      <div className={styles.panel}>
        <strong>Sold by {data.sellerCount} salon{data.sellerCount === 1 ? "" : "s"} — collect and pay at the salon</strong>
        {data.offers.map((o) => (
          <div key={o.id} className={styles.row}>
            <div>
              <div className={styles.name}>{o.salonName}</div>
              <div className={styles.meta}>{o.cityName ?? ""}{o.expiryDate ? ` · best before ${o.expiryDate}` : ""} · {o.available} available · sealed</div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className={styles.price}>{rupees(o.unitPrice)}</span>
              <select aria-label={`Quantity from ${o.salonName}`} className={styles.input} value={qty[o.id] ?? 1} onChange={(e) => setQty({ ...qty, [o.id]: Number(e.target.value) })}>
                {Array.from({ length: Math.min(o.available, 10) }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
              </select>
              <button type="button" className={styles.btn} onClick={() => { addToCart(o, qty[o.id] ?? 1); setAdded(o.id); }}>Add to cart</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Cart & checkout ----------

/** The cart (this browser) and checkout — one pickup order per salon. Requires a customer sign-in to order. */
export function ShopCart() {
  const { user } = useAuth();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [payment, setPayment] = useState<"PAY_AT_PICKUP" | "UPI_TO_SALON">("PAY_AT_PICKUP");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<MarketOrderDto[] | null>(null);
  const [key] = useState(() => newIdempotencyKey());
  // Read after mount (the cart lives in this browser), the same deferred pattern other screens use.
  useEffect(() => {
    void Promise.resolve().then(() => setLines(readCart()));
  }, []);
  const update = (next: CartLine[]) => { setLines(next); writeCart(next); };
  const total = lines.reduce((a, l) => a + Number(l.unitPrice) * l.quantity, 0);
  const salons = [...new Set(lines.map((l) => l.salonName))];
  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const orders = await apiFetch<MarketOrderDto[]>(`${P.shopRoot}/${P.orders}`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ items: lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity })), paymentMethod: payment }) });
      setPlaced(orders);
      update([]);
    } catch (e) {
      setError(errorText(e, "Your order was not placed."));
    } finally {
      setBusy(false);
    }
  }
  if (placed)
    return (
      <div className={styles.page}>
        <h1 className={styles.title}>Order placed</h1>
        <div className={styles.ok}>The salon will confirm and tell you when it&apos;s ready. Show your pickup code at the salon and pay there.</div>
        {placed.map((o) => <div key={o.id} className={styles.panel}><strong>{o.seller.name}</strong> · order {o.number}<div>Pickup code: <span className={styles.code}>{o.pickupCode}</span></div></div>)}
        <p><Link href="/shop/orders">Track my orders</Link></p>
      </div>
    );
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Your cart</h1>
      {lines.length === 0 ? <p className={styles.sub}>Your cart is empty. <Link href="/shop">Browse products</Link></p> : (
        <>
          <div className={styles.panel}>
            {lines.map((l) => (
              <div key={l.listingId} className={styles.row}>
                <div><div className={styles.name}>{l.title}</div><div className={styles.meta}>Collect at {l.salonName}</div></div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select aria-label={`Quantity of ${l.title}`} className={styles.input} value={l.quantity} onChange={(e) => update(lines.map((x) => (x.listingId === l.listingId ? { ...x, quantity: Number(e.target.value) } : x)))}>
                    {Array.from({ length: Math.min(l.available, 10) }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                  </select>
                  <span className={styles.price}>{rupees(String(Number(l.unitPrice) * l.quantity))}</span>
                  <button type="button" className={styles.btnQuiet} onClick={() => update(lines.filter((x) => x.listingId !== l.listingId))}>Remove</button>
                </div>
              </div>
            ))}
            <div className={styles.row}><strong>Total</strong><span className={styles.price}>{rupees(String(total))}</span></div>
          </div>
          <div className={styles.panel}>
            <strong>Pickup &amp; payment</strong>
            <p className={styles.sub}>{salons.length > 1 ? `This makes ${salons.length} orders, one for each salon (${salons.join(", ")}).` : `Collect at ${salons[0]}.`} You pay the salon directly — FastQue doesn&apos;t take payment.</p>
            <label><input type="radio" checked={payment === "PAY_AT_PICKUP"} onChange={() => setPayment("PAY_AT_PICKUP")} /> Pay at the salon when I collect (cash or UPI)</label><br />
            <label><input type="radio" checked={payment === "UPI_TO_SALON"} onChange={() => setPayment("UPI_TO_SALON")} /> Pay the salon now by UPI (if the salon accepts it)</label>
          </div>
          {error && <div className={styles.error}>{error}</div>}
          {user ? (
            <p><button type="button" className={styles.btn} disabled={busy} onClick={() => void checkout()}>{busy ? "Placing…" : "Place order"}</button></p>
          ) : (
            <p className={styles.notice}><Link href="/login?next=/shop/cart">Sign in</Link> to place your order.</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------- Orders ----------

const STATUS: Record<string, string> = {
  PLACED: "Waiting for the salon", ACCEPTED: "Confirmed — being prepared", READY_FOR_PICKUP: "Ready to collect", COMPLETED: "Collected",
  CANCELLED: "Cancelled", EXPIRED: "Expired", RETURN_REQUESTED: "Return asked", RETURNED: "Returned", DISPUTED: "Under review", DISPATCHED: "On the way",
};

/** The customer's orders: status, pickup code, UPI QR, cancel and returns. */
export function ShopOrders() {
  const [orders, setOrders] = useState<MarketOrderDto[] | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = () => void apiFetch<MarketOrderDto[]>(`${P.shopRoot}/${P.orders}`).then(setOrders).catch((e) => setMsg({ tone: "error", text: errorText(e, "Could not load your orders.") }));
  useEffect(load, []);
  async function act(o: MarketOrderDto, path: string, prompt: string) {
    const reason = window.prompt(prompt);
    if (!reason) return;
    try {
      await apiFetch(`${P.shopRoot}/${P.orders}/${o.id}/${path}`, { method: "POST", body: JSON.stringify({ reason }) });
      setMsg({ tone: "ok", text: path === P.cancel ? "Order cancelled." : "Return asked. The salon will reply." });
      load();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "That did not work.") });
    }
  }
  return (
    <div className={styles.page}>
      <div className={styles.head}><h1 className={styles.title}>My product orders</h1><Link href="/shop" className={styles.btnQuiet}>Shop</Link></div>
      {msg && <div className={msg.tone === "ok" ? styles.ok : styles.error}>{msg.text}</div>}
      {!orders ? <p className={styles.sub}>Loading…</p> : orders.length === 0 ? <p className={styles.sub}>No orders yet. <Link href="/shop">Browse products</Link></p> : orders.map((o) => (
        <div key={o.id} className={styles.panel}>
          <div className={styles.row}>
            <div><strong>{o.seller.name}</strong> · {o.number}<div className={styles.meta}>{o.seller.address}{o.seller.phone ? ` · ${o.seller.phone}` : ""}</div></div>
            <span className={styles.badge}>{STATUS[o.status] ?? o.status}</span>
          </div>
          {o.items.map((i) => <div key={i.listingId} className={styles.meta}>{i.quantity} × {i.title} · {rupees(i.unitPrice)}</div>)}
          <div className={styles.row}><span>Total {rupees(o.total)} · {o.paymentMethod === "UPI_TO_SALON" ? "UPI to the salon" : "Pay at pickup"}{o.paid ? " · paid" : ""}</span>
            {["PLACED", "ACCEPTED", "READY_FOR_PICKUP"].includes(o.status) && o.pickupCode && <span>Pickup code <span className={styles.code}>{o.pickupCode}</span></span>}
          </div>
          {o.upiQrImageUrl && !o.paid && ["ACCEPTED", "READY_FOR_PICKUP", "PLACED"].includes(o.status) && (
            <div>
              Scan to pay {o.seller.name}:
              {/* eslint-disable-next-line @next/next/no-img-element -- the salon's own UPI QR */}
              <img className={styles.qr} src={o.upiQrImageUrl} alt={`UPI QR code of ${o.seller.name}`} />
            </div>
          )}
          {o.cancelReason && <div className={styles.meta}>Reason: {o.cancelReason}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            {o.status === "PLACED" && <button type="button" className={styles.btnQuiet} onClick={() => void act(o, P.cancel, "Why are you cancelling?")}>Cancel</button>}
            {o.status === "COMPLETED" && <button type="button" className={styles.btnQuiet} onClick={() => void act(o, P.requestReturn, "Why do you want to return it? (sealed items, within 7 days)")}>Ask for a return</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
