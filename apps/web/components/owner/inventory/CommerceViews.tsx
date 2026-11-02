"use client";

import { useEffect, useState } from "react";
import {
  CATALOG_PATHS,
  COMMERCE_PATHS as P,
  INVENTORY_PATHS,
  type InventoryProductDto,
  type InventorySupplierDto,
  type ListingDto,
  type MarketOrderDto,
  type PurchaseOrderDto,
  type SupplierComparisonDto,
  type SupplierOfferDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { moneyText, quantityText, trimDecimal } from "../../../lib/inventory";
import { inventoryBase, loadAll } from "../../../lib/use-inventory-lookups";
import { Badge, Banner, Btn, Card, EmptyState, Field, Skeleton } from "../parts";
import ui from "../owner.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const rupees = (v: string | number) => moneyText(String(v), "INR");
type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void apiFetch<T>(path)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(errorText(e, "Could not load.")));
    return () => {
      cancelled = true;
    };
  }, [path, v]);
  return { data, error, reload: () => setV((x) => x + 1) };
}

/** Uploads a photo (catalog image storage) and returns its link; a pasted link also works. */
function PhotoInput({ salonId, onAdd, label }: { salonId: string; onAdd: (url: string) => void; label: string }) {
  const [link, setLink] = useState("");
  const [note, setNote] = useState<string | null>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    const body = new FormData();
    body.append("image", file);
    try {
      const { url } = await apiFetch<{ url: string }>(`${inventoryBase(salonId)}/${CATALOG_PATHS.catalog}/${CATALOG_PATHS.images}`, { method: "POST", body });
      onAdd(url);
      setNote(null);
    } catch (e) {
      setNote(errorText(e, "Upload failed — paste a link to the photo instead."));
    }
  }
  return (
    <div className={ui.rowWrap}>
      <label className={ui.label}>
        {label} <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      </label>
      <input className={ui.input} placeholder="or paste a photo link (https://…)" value={link} onChange={(e) => setLink(e.target.value)} />
      <Btn small onClick={() => { if (/^https:\/\/\S+$/.test(link.trim())) { onAdd(link.trim()); setLink(""); setNote(null); } else setNote("Paste a full https:// link."); }}>Add</Btn>
      {note && <span className={ui.hint}>{note}</span>}
    </div>
  );
}

const PO_TONE: Record<string, Tone> = { DRAFT: "neutral", PLACED: "info", CONFIRMED: "info", DISPATCHED: "info", PARTIALLY_RECEIVED: "warn", RECEIVED: "ok", REJECTED: "bad", CANCELLED: "bad" };
const poStatus = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

// ---------- Purchase orders ----------

function ReceiveForm({ salonId, po, onDone }: { salonId: string; po: PurchaseOrderDto; onDone: (p: PurchaseOrderDto) => void }) {
  const [rows, setRows] = useState(() =>
    Object.fromEntries(po.items.map((i) => [i.id, { received: String(Math.max(0, Number(i.quantity) - Number(i.receivedQuantity) - Number(i.damagedQuantity))), damaged: "0", batch: "", expiry: "", barcode: "", note: "" }])),
  );
  const [key] = useState(() => newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (id: string, patch: Partial<(typeof rows)[string]>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const lines = po.items.map((i) => ({
        purchaseOrderItemId: i.id,
        quantityReceived: Number(rows[i.id].received) || 0,
        quantityDamaged: Number(rows[i.id].damaged) || 0,
        batchNumber: rows[i.id].batch.trim() || null,
        expiryDate: rows[i.id].expiry || null,
        scannedBarcode: rows[i.id].barcode.trim() || null,
        discrepancyNote: rows[i.id].note.trim() || null,
      }));
      onDone(await apiFetch<PurchaseOrderDto>(`${inventoryBase(salonId)}/${P.purchaseOrders}/${po.id}/${P.receive}`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ lines }) }));
    } catch (e) {
      setError(errorText(e, "Not received — check the lines and try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Receive a delivery" sub="Count what actually arrived. Only good items are added to stock; damaged ones are recorded. Scan or type the barcode on the box to check it's the right product.">
      {po.items.map((i) => (
        <div key={i.id} className={`${ui.rowWrap} ${ui.mt12}`}>
          <strong style={{ minWidth: 160 }}>{i.name}<div className={ui.hint}>Ordered {trimDecimal(i.quantity)}, received so far {trimDecimal(i.receivedQuantity)}</div></strong>
          <Field label="Good" htmlFor={`rcv-${i.id}`}><input id={`rcv-${i.id}`} className={ui.input} style={{ width: 80 }} inputMode="decimal" value={rows[i.id].received} onChange={(e) => set(i.id, { received: e.target.value })} /></Field>
          <Field label="Damaged" htmlFor={`dmg-${i.id}`}><input id={`dmg-${i.id}`} className={ui.input} style={{ width: 80 }} inputMode="decimal" value={rows[i.id].damaged} onChange={(e) => set(i.id, { damaged: e.target.value })} /></Field>
          <Field label="Batch" htmlFor={`bat-${i.id}`}><input id={`bat-${i.id}`} className={ui.input} style={{ width: 110 }} value={rows[i.id].batch} onChange={(e) => set(i.id, { batch: e.target.value })} /></Field>
          <Field label="Expiry" htmlFor={`exp-${i.id}`}><input id={`exp-${i.id}`} type="date" className={ui.input} value={rows[i.id].expiry} onChange={(e) => set(i.id, { expiry: e.target.value })} /></Field>
          {i.barcode && <Field label="Barcode on the box" htmlFor={`bc-${i.id}`}><input id={`bc-${i.id}`} className={ui.input} style={{ width: 150 }} inputMode="numeric" value={rows[i.id].barcode} onChange={(e) => set(i.id, { barcode: e.target.value })} /></Field>}
          <Field label="Note" htmlFor={`nt-${i.id}`}><input id={`nt-${i.id}`} className={ui.input} value={rows[i.id].note} onChange={(e) => set(i.id, { note: e.target.value })} placeholder="e.g. 2 short" /></Field>
        </div>
      ))}
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}><Btn variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? "Saving…" : "Add to stock"}</Btn></div>
    </Card>
  );
}

function PoDetail({ salonId, po, onChange }: { salonId: string; po: PurchaseOrderDto; onChange: (p: PurchaseOrderDto) => void }) {
  const [error, setError] = useState<string | null>(null);
  const base = `${inventoryBase(salonId)}/${P.purchaseOrders}/${po.id}`;
  async function act(path: string, body?: unknown) {
    setError(null);
    try {
      onChange(await apiFetch<PurchaseOrderDto>(`${base}/${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }));
    } catch (e) {
      setError(errorText(e, "That did not work."));
    }
  }
  return (
    <div className={ui.mt16}>
      <Card title={`${po.number} · ${po.supplier.name}`} sub={`${poStatus(po.status)}${po.expectedDeliveryDate ? ` · expected ${po.expectedDeliveryDate}` : ""}${po.supplierNote ? ` · supplier: ${po.supplierNote}` : ""}`}>
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead><tr><th>Item</th><th className={ui.num}>Ordered</th><th className={ui.num}>Price</th><th className={ui.num}>Received</th><th className={ui.num}>Damaged</th></tr></thead>
            <tbody>{po.items.map((i) => <tr key={i.id}><td>{i.name}{i.barcode && <div className={ui.hint}>{i.barcode}</div>}</td><td className={ui.num}>{trimDecimal(i.quantity)}</td><td className={ui.num}>{rupees(i.unitPrice)}</td><td className={ui.num}>{trimDecimal(i.receivedQuantity)}</td><td className={ui.num}>{trimDecimal(i.damagedQuantity)}</td></tr>)}</tbody>
          </table>
        </div>
        <p className={ui.cardSub}>Items {rupees(po.subtotal)} · delivery {rupees(po.deliveryCharge)} · total {rupees(po.total)}. Pay the supplier on their invoice — FastQue doesn&apos;t take payment.</p>
        {po.invoiceUrls.length > 0 && <p className={ui.hint}>Invoices: {po.invoiceUrls.map((u, n) => <a key={u} href={u} target="_blank" rel="noreferrer">photo {n + 1} </a>)}</p>}
        <PhotoInput salonId={salonId} label="Attach invoice photo" onAdd={(url) => void act(P.invoice, { url })} />
        {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          {po.status === "DRAFT" && <Btn variant="primary" onClick={() => void act(P.place)}>Place order</Btn>}
          {["DRAFT", "PLACED", "CONFIRMED"].includes(po.status) && (
            <Btn variant="quiet" onClick={() => { const reason = window.prompt("Why cancel this order?"); if (reason) void act(P.cancel, { reason }); }}>Cancel order</Btn>
          )}
        </div>
      </Card>
      {["PLACED", "CONFIRMED", "DISPATCHED", "PARTIALLY_RECEIVED"].includes(po.status) && (
        <div className={ui.mt16}><ReceiveForm key={po.receipts.length} salonId={salonId} po={po} onDone={onChange} /></div>
      )}
    </div>
  );
}

type MarketSupplier = { id: string; name: string; deliversToShopCity: boolean; defaultLeadTimeDays: number; deliveryCharge: string; freeDeliveryAbove: string | null; minimumOrderValue: string | null; offerCount: number };

function NewPurchaseOrder({ salonId, onCreated }: { salonId: string; onCreated: (p: PurchaseOrderDto) => void }) {
  const base = inventoryBase(salonId);
  const [kind, setKind] = useState<"MARKETPLACE" | "OWN">("MARKETPLACE");
  const market = useLoad<MarketSupplier[]>(`${base}/marketplace-suppliers`);
  const [supplierId, setSupplierId] = useState("");
  const offers = useLoad<SupplierOfferDto[]>(kind === "MARKETPLACE" && supplierId ? `${base}/marketplace-suppliers/${supplierId}/offers` : null);
  const [own, setOwn] = useState<{ suppliers: InventorySupplierDto[]; products: InventoryProductDto[] }>({ suppliers: [], products: [] });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [price, setPrice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void Promise.all([loadAll<InventorySupplierDto>(`${base}/${INVENTORY_PATHS.suppliers}`), loadAll<InventoryProductDto>(`${base}/${INVENTORY_PATHS.products}`)])
      .then(([s, p]) => setOwn({ suppliers: s.items, products: p.items.filter((x) => x.isActive) }))
      .catch(() => undefined);
  }, [base]);

  async function create() {
    setError(null);
    const items =
      kind === "MARKETPLACE"
        ? (offers.data ?? []).filter((o) => Number(qty[o.id]) > 0).map((o) => ({ globalProductId: o.globalProductId, quantity: Number(qty[o.id]), unitPrice: Number(o.unitPrice) }))
        : own.products.filter((p) => Number(qty[p.id]) > 0).map((p) => ({ inventoryProductId: p.id, quantity: Number(qty[p.id]), unitPrice: Number(price[p.id] || 0) }));
    if (!supplierId) return setError("Choose a supplier.");
    if (!items.length) return setError("Enter a quantity for at least one product.");
    setBusy(true);
    try {
      onCreated(await apiFetch<PurchaseOrderDto>(`${base}/${P.purchaseOrders}`, { method: "POST", body: JSON.stringify({ ...(kind === "MARKETPLACE" ? { marketplaceSupplierId: supplierId } : { inventorySupplierId: supplierId }), items }) }));
      setQty({});
    } catch (e) {
      setError(errorText(e, "The order was not created."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New purchase order" sub="Saved as a draft. Placing it sends it to the supplier; your stock only changes when you receive the goods.">
      <div className={ui.rowWrap}>
        <label className={ui.label}><input type="radio" checked={kind === "MARKETPLACE"} onChange={() => { setKind("MARKETPLACE"); setSupplierId(""); }} /> FastQue supplier</label>
        <label className={ui.label}><input type="radio" checked={kind === "OWN"} onChange={() => { setKind("OWN"); setSupplierId(""); }} /> My own supplier</label>
      </div>
      <Field label="Supplier" htmlFor="po-supplier">
        <select id="po-supplier" className={ui.input} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Choose…</option>
          {kind === "MARKETPLACE"
            ? (market.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.defaultLeadTimeDays} days · delivery {rupees(s.deliveryCharge)}{s.deliversToShopCity ? "" : " · doesn't list your city"}</option>)
            : own.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      {kind === "MARKETPLACE" && market.data && market.data.length === 0 && <p className={ui.hint}>No FastQue suppliers are approved yet.</p>}
      {kind === "MARKETPLACE" && supplierId && (
        <div className={`${ui.tableWrap} ${ui.mt12}`}>
          <table className={ui.table}>
            <thead><tr><th>Product</th><th className={ui.num}>Price</th><th className={ui.num}>Min order</th><th className={ui.num}>Available</th><th className={ui.num}>Quantity</th></tr></thead>
            <tbody>
              {(offers.data ?? []).map((o) => (
                <tr key={o.id}><td>{o.productName}<div className={ui.hint}>{[o.brand, o.barcode].filter(Boolean).join(" · ")}</div></td><td className={ui.num}>{rupees(o.unitPrice)}</td><td className={ui.num}>{o.minOrderQuantity}</td><td className={ui.num}>{o.availableQuantity ?? "not shared"}</td>
                  <td className={ui.num}><input aria-label={`Quantity of ${o.productName}`} className={ui.input} style={{ width: 80 }} inputMode="numeric" value={qty[o.id] ?? ""} onChange={(e) => setQty({ ...qty, [o.id]: e.target.value })} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kind === "OWN" && supplierId && (
        <div className={`${ui.tableWrap} ${ui.mt12}`}>
          <table className={ui.table}>
            <thead><tr><th>Product</th><th className={ui.num}>Quantity</th><th className={ui.num}>Price each</th></tr></thead>
            <tbody>{own.products.map((p) => (
              <tr key={p.id}><td>{p.name}<div className={ui.hint}>In stock {quantityText(p.stockOnHand, p.unit)}</div></td>
                <td className={ui.num}><input aria-label={`Quantity of ${p.name}`} className={ui.input} style={{ width: 80 }} inputMode="decimal" value={qty[p.id] ?? ""} onChange={(e) => setQty({ ...qty, [p.id]: e.target.value })} /></td>
                <td className={ui.num}><input aria-label={`Price of ${p.name}`} className={ui.input} style={{ width: 90 }} inputMode="decimal" value={price[p.id] ?? ""} onChange={(e) => setPrice({ ...price, [p.id]: e.target.value })} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}><Btn variant="primary" disabled={busy} onClick={() => void create()}>{busy ? "Saving…" : "Save draft"}</Btn></div>
    </Card>
  );
}

function CompareSuppliers({ salonId }: { salonId: string }) {
  const [products, setProducts] = useState<InventoryProductDto[]>([]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("10");
  const [result, setResult] = useState<SupplierComparisonDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadAll<InventoryProductDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}`).then((r) => setProducts(r.items.filter((p) => p.globalProductId && p.isActive))).catch(() => undefined);
  }, [salonId]);
  async function compare() {
    const p = products.find((x) => x.id === productId);
    if (!p?.globalProductId || !(Number(quantity) > 0)) return setError("Choose a product and a quantity.");
    setError(null);
    try {
      setResult(await apiFetch<SupplierComparisonDto>(`${inventoryBase(salonId)}/${P.compare}?globalProductId=${p.globalProductId}&quantity=${Number(quantity)}`));
    } catch (e) {
      setError(errorText(e, "Could not compare."));
    }
  }
  return (
    <Card title="Compare suppliers" sub="Prices for the quantity you need, with each supplier's minimum order and delivery charge. Cheapest total first.">
      <div className={ui.rowWrap}>
        <Field label="Product" htmlFor="cmp-product"><select id="cmp-product" className={ui.input} value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Quantity" htmlFor="cmp-qty"><input id="cmp-qty" className={ui.input} style={{ width: 90 }} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></Field>
        <Btn onClick={() => void compare()}>Compare</Btn>
      </div>
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      {result && (result.quotes.length === 0 ? <p className={ui.hint}>No FastQue supplier sells {result.productName} yet.</p> : (
        <div className={`${ui.tableWrap} ${ui.mt12}`}>
          <table className={ui.table}>
            <thead><tr><th>Supplier</th><th className={ui.num}>Price</th><th className={ui.num}>You&apos;d order</th><th className={ui.num}>Delivery</th><th className={ui.num}>Total</th><th>Arrives in</th></tr></thead>
            <tbody>{result.quotes.map((q) => (
              <tr key={q.offerId}><td>{q.supplierName}{!q.deliversToShopCity && <div className={ui.hint}>Doesn&apos;t list your city</div>}{q.canSupply === false && <div className={ui.hint}>Not enough stock</div>}{q.canSupply === null && <div className={ui.hint}>Stock not shared</div>}</td>
                <td className={ui.num}>{rupees(q.unitPrice)}</td><td className={ui.num}>{q.orderQuantity}{q.orderQuantity > result.quantity ? ` (min ${q.minOrderQuantity})` : ""}</td><td className={ui.num}>{rupees(q.delivery)}</td><td className={ui.num}><strong>{rupees(q.total)}</strong></td><td>{q.leadTimeDays} days</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
    </Card>
  );
}

function BuyFromSalons({ salonId }: { salonId: string }) {
  const [q, setQ] = useState("");
  const list = useLoad<ListingDto[]>(`${inventoryBase(salonId)}/${P.salonMarket}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  async function order(l: ListingDto) {
    const n = Number(qty[l.id] || 1);
    try {
      await apiFetch(`${inventoryBase(salonId)}/${P.salonMarket}/orders`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey() }, body: JSON.stringify({ items: [{ listingId: l.id, quantity: n }], paymentMethod: "INVOICE" }) });
      setMsg({ tone: "ok", text: `Ordered ${n} × ${l.title} from ${l.salonName}. Track it under Orders.` });
      list.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "Not ordered.") });
    }
  }
  return (
    <Card title="Buy from other salons" sub="Sealed surplus stock other salons listed, checked by FastQue. Your stock goes up when you confirm you received it.">
      <Field label="Search" htmlFor="b2b-q"><input id="b2b-q" className={ui.input} type="search" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
      {msg && <div className={ui.mt12}><Banner tone={msg.tone === "ok" ? "ok" : "error"}>{msg.text}</Banner></div>}
      {!list.data ? <Skeleton height={60} /> : list.data.length === 0 ? <EmptyState title="Nothing listed by other salons right now" /> : (
        <div className={`${ui.tableWrap} ${ui.mt12}`}>
          <table className={ui.table}>
            <thead><tr><th>Product</th><th>Salon</th><th className={ui.num}>Price</th><th className={ui.num}>Available</th><th>Expiry</th><th className={ui.num}>Quantity</th><th aria-label="Order" /></tr></thead>
            <tbody>{list.data.map((l) => (
              <tr key={l.id}><td>{l.title}</td><td>{l.salonName}{l.cityName ? ` · ${l.cityName}` : ""}</td><td className={ui.num}>{rupees(l.unitPrice)}</td><td className={ui.num}>{l.available}</td><td>{l.expiryDate ?? "—"}</td>
                <td className={ui.num}><input aria-label={`Quantity of ${l.title}`} className={ui.input} style={{ width: 70 }} inputMode="numeric" value={qty[l.id] ?? "1"} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /></td>
                <td><Btn small onClick={() => void order(l)}>Order</Btn></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Owner: purchase orders (FastQue or own suppliers), receiving, supplier comparison and buying from salons. */
export function PurchaseOrdersView({ salonId }: { salonId: string }) {
  const list = useLoad<PurchaseOrderDto[]>(`${inventoryBase(salonId)}/${P.purchaseOrders}`);
  const [selected, setSelected] = useState<PurchaseOrderDto | null>(null);
  const update = (p: PurchaseOrderDto) => { setSelected(p); list.reload(); };
  return (
    <div className={ui.mt16}>
      <Card title="Purchase orders">
        {list.error ? <Banner tone="error">{list.error}</Banner> : !list.data ? <Skeleton height={80} /> : list.data.length === 0 ? <EmptyState title="No purchase orders yet" /> : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead><tr><th>Order</th><th>Supplier</th><th>Status</th><th className={ui.num}>Total</th><th aria-label="Open" /></tr></thead>
              <tbody>{list.data.map((p) => (
                <tr key={p.id}><td>{p.number}<div className={ui.hint}>{p.createdAt.slice(0, 10)}</div></td><td>{p.supplier.name}{p.supplier.kind === "MARKETPLACE" && <div className={ui.hint}>FastQue supplier</div>}</td><td><Badge tone={PO_TONE[p.status]}>{poStatus(p.status)}</Badge></td><td className={ui.num}>{rupees(p.total)}</td><td><Btn small variant="quiet" onClick={() => setSelected(p)}>Open</Btn></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {selected && <PoDetail key={selected.id + selected.status + selected.receipts.length} salonId={salonId} po={selected} onChange={update} />}
      <div className={ui.mt16}><NewPurchaseOrder salonId={salonId} onCreated={update} /></div>
      <div className={ui.mt16}><CompareSuppliers salonId={salonId} /></div>
      <div className={ui.mt16}><BuyFromSalons salonId={salonId} /></div>
    </div>
  );
}

// ---------- Selling ----------

const LISTING_TONE: Record<string, Tone> = { PENDING_REVIEW: "warn", ACTIVE: "ok", PAUSED: "neutral", REJECTED: "bad", ENDED: "neutral" };
const LISTING_TEXT: Record<string, string> = { PENDING_REVIEW: "Waiting for FastQue review", ACTIVE: "Live", PAUSED: "Paused", REJECTED: "Rejected", ENDED: "Ended" };

/** Owner: list sealed stock for other salons or for customers (pickup), after FastQue review. */
export function SellView({ salonId }: { salonId: string }) {
  const base = inventoryBase(salonId);
  const list = useLoad<ListingDto[]>(`${base}/${P.listings}`);
  const [products, setProducts] = useState<InventoryProductDto[]>([]);
  const [form, setForm] = useState({ productId: "", channel: "CUSTOMER", quantity: "1", price: "", batch: "", expiry: "", provenance: "", description: "", sealed: false });
  const [photos, setPhotos] = useState<string[]>([]);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    void loadAll<InventoryProductDto>(`${base}/${INVENTORY_PATHS.products}`).then((r) => setProducts(r.items.filter((p) => p.isActive && p.globalProductId && Number(p.stockOnHand) >= 1))).catch(() => undefined);
  }, [base]);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    setMsg(null);
    try {
      await apiFetch(`${base}/${P.listings}`, {
        method: "POST",
        body: JSON.stringify({
          inventoryProductId: form.productId,
          channel: form.channel,
          quantity: Number(form.quantity),
          unitPrice: Math.round(Number(form.price) * 100) / 100,
          sealed: form.sealed,
          batchNumber: form.batch.trim() || null,
          expiryDate: form.expiry || null,
          photoUrls: photos,
          provenanceNote: form.provenance.trim() || null,
          invoiceUrl: invoice,
          description: form.description.trim() || null,
        }),
      });
      setMsg({ tone: "ok", text: "Sent to FastQue for review. It goes live once approved." });
      setPhotos([]);
      setInvoice(null);
      list.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "Not submitted.") });
    }
  }
  async function act(id: string, action: "pause" | "resume" | "end") {
    try {
      await apiFetch(`${base}/${P.listings}/${id}/${action}`, { method: "POST" });
      list.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "That did not work.") });
    }
  }
  return (
    <div className={ui.mt16}>
      <Card title="Sell excess stock" sub="Only sealed products verified in the FastQue catalog, with photos of the actual stock and at least 30 days before expiry. Customers collect from your shop and pay you there; salons pay on your invoice. FastQue reviews every listing first.">
        <div className={ui.rowWrap}>
          <Field label="Product" htmlFor="ls-product"><select id="ls-product" className={ui.input} value={form.productId} onChange={(e) => set({ productId: e.target.value })}><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {quantityText(p.stockOnHand, p.unit)} in stock</option>)}</select></Field>
          <Field label="Sell to" htmlFor="ls-channel"><select id="ls-channel" className={ui.input} value={form.channel} onChange={(e) => set({ channel: e.target.value })}><option value="CUSTOMER">Customers (pickup at my shop)</option><option value="SALON">Other salons</option></select></Field>
          <Field label="Quantity (pieces)" htmlFor="ls-qty"><input id="ls-qty" className={ui.input} style={{ width: 90 }} inputMode="numeric" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
          <Field label="Price each (₹)" htmlFor="ls-price"><input id="ls-price" className={ui.input} style={{ width: 100 }} inputMode="decimal" value={form.price} onChange={(e) => set({ price: e.target.value })} /></Field>
        </div>
        <div className={ui.rowWrap}>
          <Field label="Batch (optional)" htmlFor="ls-batch"><input id="ls-batch" className={ui.input} value={form.batch} onChange={(e) => set({ batch: e.target.value })} /></Field>
          <Field label="Expiry date" htmlFor="ls-expiry"><input id="ls-expiry" type="date" className={ui.input} value={form.expiry} onChange={(e) => set({ expiry: e.target.value })} /></Field>
          <Field label="Where it came from" htmlFor="ls-prov" hint={form.channel === "SALON" ? "Required for salon sales (or attach the invoice)." : undefined}><input id="ls-prov" className={ui.input} value={form.provenance} onChange={(e) => set({ provenance: e.target.value })} placeholder="e.g. bought on PO-0003" /></Field>
        </div>
        <Field label="Description (optional)" htmlFor="ls-desc"><input id="ls-desc" className={ui.input} maxLength={500} value={form.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        <PhotoInput salonId={salonId} label="Photo of the stock" onAdd={(url) => setPhotos((p) => [...p, url].slice(0, 6))} />
        {photos.length > 0 && <p className={ui.hint}>{photos.length} photo{photos.length === 1 ? "" : "s"} added.</p>}
        {form.channel === "SALON" && <PhotoInput salonId={salonId} label="Purchase invoice photo" onAdd={setInvoice} />}
        {invoice && <p className={ui.hint}>Invoice attached.</p>}
        <label className={ui.label}><input type="checkbox" checked={form.sealed} onChange={(e) => set({ sealed: e.target.checked })} /> This stock is sealed and unopened</label>
        {msg && <div className={ui.mt12}><Banner tone={msg.tone === "ok" ? "ok" : "error"}>{msg.text}</Banner></div>}
        <div className={`${ui.rowWrap} ${ui.mt12}`}><Btn variant="primary" onClick={() => void submit()}>Send for review</Btn></div>
      </Card>
      <div className={ui.mt16}>
        <Card title="My listings">
          {!list.data ? <Skeleton height={60} /> : list.data.length === 0 ? <EmptyState title="Nothing listed yet" /> : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Product</th><th>To</th><th>Status</th><th className={ui.num}>Price</th><th className={ui.num}>Listed / held / sold</th><th aria-label="Actions" /></tr></thead>
                <tbody>{list.data.map((l) => (
                  <tr key={l.id}><td>{l.title}{l.reviewNote && <div className={ui.hint}>FastQue: {l.reviewNote}</div>}</td><td>{l.channel === "CUSTOMER" ? "Customers" : "Salons"}</td><td><Badge tone={LISTING_TONE[l.status]}>{LISTING_TEXT[l.status]}</Badge></td><td className={ui.num}>{rupees(l.unitPrice)}</td><td className={ui.num}>{l.quantityListed} / {l.quantityReserved} / {l.quantitySold}</td>
                    <td className={ui.rowWrap}>{l.status === "ACTIVE" && <Btn small variant="quiet" onClick={() => void act(l.id, "pause")}>Pause</Btn>}{l.status === "PAUSED" && <Btn small variant="quiet" onClick={() => void act(l.id, "resume")}>Resume</Btn>}{["PENDING_REVIEW", "ACTIVE", "PAUSED"].includes(l.status) && <Btn small variant="quiet" onClick={() => void act(l.id, "end")}>End</Btn>}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------- Orders ----------

const ORDER_TONE: Record<string, Tone> = { PLACED: "warn", ACCEPTED: "info", READY_FOR_PICKUP: "info", DISPATCHED: "info", COMPLETED: "ok", CANCELLED: "bad", EXPIRED: "neutral", RETURN_REQUESTED: "warn", RETURNED: "neutral", DISPUTED: "bad" };
export const orderStatusText = (s: string) => ({ PLACED: "New", READY_FOR_PICKUP: "Ready for pickup", RETURN_REQUESTED: "Return asked" } as Record<string, string>)[s] ?? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

function OrderRow({ o, actions }: { o: MarketOrderDto; actions: React.ReactNode }) {
  return (
    <tr>
      <td>{o.number}<div className={ui.hint}>{o.createdAt.slice(0, 10)} · {o.channel === "CUSTOMER" ? "Customer pickup" : o.buyer.name ?? o.seller.name}</div></td>
      <td>{o.items.map((i) => `${i.quantity} × ${i.title}`).join(", ")}{o.returnReason && <div className={ui.hint}>Return: {o.returnReason}</div>}{o.disputeReason && <div className={ui.hint}>Problem: {o.disputeReason}</div>}</td>
      <td className={ui.num}>{rupees(o.total)}<div className={ui.hint}>{o.paymentMethod === "INVOICE" ? "On invoice" : o.paymentMethod === "UPI_TO_SALON" ? "UPI to shop" : "Pay at pickup"}{o.paid ? " · paid" : ""}</div></td>
      <td><Badge tone={ORDER_TONE[o.status]}>{orderStatusText(o.status)}</Badge></td>
      <td className={ui.rowWrap}>{actions}</td>
    </tr>
  );
}

/** Owner: orders this shop is selling (customers and salons) and buying from other salons. */
export function MarketOrdersView({ salonId }: { salonId: string }) {
  const base = inventoryBase(salonId);
  const sales = useLoad<MarketOrderDto[]>(`${base}/${P.sales}`);
  const buys = useLoad<MarketOrderDto[]>(`${base}/${P.purchases}`);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  async function call(path: string, body?: unknown, ok?: string) {
    setMsg(null);
    try {
      await apiFetch(`${base}/${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      if (ok) setMsg({ tone: "ok", text: ok });
      sales.reload();
      buys.reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "That did not work.") });
    }
  }
  const sell = (o: MarketOrderDto, a: string) => `${P.sales}/${o.id}/${a}`;
  const cancel = (path: string) => { const reason = window.prompt("Tell them why:"); if (reason) void call(path, { reason }); };
  return (
    <div className={ui.mt16}>
      {msg && <Banner tone={msg.tone === "ok" ? "ok" : "error"}>{msg.text}</Banner>}
      <Card title="Selling" sub="Accept within 48 hours or the order expires. For customer orders, ask for their 6-digit pickup code and take payment before handing over.">
        {!sales.data ? <Skeleton height={60} /> : sales.data.length === 0 ? <EmptyState title="No orders yet" /> : (
          <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Order</th><th>Items</th><th className={ui.num}>Total</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{sales.data.map((o) => (
              <OrderRow key={o.id} o={o} actions={<>
                {o.status === "PLACED" && <Btn small variant="primary" onClick={() => void call(sell(o, P.accept))}>Accept</Btn>}
                {o.status === "ACCEPTED" && o.channel === "CUSTOMER" && <Btn small variant="primary" onClick={() => void call(sell(o, P.ready), undefined, "Customer told it's ready.")}>Ready for pickup</Btn>}
                {o.status === "ACCEPTED" && o.channel === "SALON" && <Btn small variant="primary" onClick={() => void call(sell(o, P.dispatch), undefined, "Dispatched — stock taken off.")}>Dispatched</Btn>}
                {o.status === "READY_FOR_PICKUP" && <Btn small variant="primary" onClick={() => { const code = window.prompt("Customer's 6-digit pickup code:"); if (code) void call(sell(o, P.complete), { pickupCode: code.trim(), paid: true }, "Handed over — stock taken off."); }}>Hand over</Btn>}
                {o.paymentMethod === "UPI_TO_SALON" && !o.paid && ["ACCEPTED", "READY_FOR_PICKUP"].includes(o.status) && <Btn small variant="quiet" onClick={() => void call(sell(o, P.markPaid))}>UPI received</Btn>}
                {["PLACED", "ACCEPTED", "READY_FOR_PICKUP"].includes(o.status) && <Btn small variant="quiet" onClick={() => cancel(sell(o, P.cancel))}>Cancel</Btn>}
                {o.status === "RETURN_REQUESTED" && <><Btn small onClick={() => void call(sell(o, P.returnDecision), { approve: true }, "Return accepted — stock put back. Refund the customer at the shop.")}>Accept return</Btn><Btn small variant="quiet" onClick={() => void call(sell(o, P.returnDecision), { approve: false, note: window.prompt("Why not?") || "Not eligible" })}>Decline</Btn></>}
              </>} />
            ))}</tbody></table></div>
        )}
      </Card>
      <div className={ui.mt16}>
        <Card title="Buying from other salons">
          {!buys.data ? <Skeleton height={60} /> : buys.data.length === 0 ? <EmptyState title="Nothing bought from salons yet" /> : (
            <div className={ui.tableWrap}><table className={ui.table}><thead><tr><th>Order</th><th>Items</th><th className={ui.num}>Total</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>{buys.data.map((o) => (
                <OrderRow key={o.id} o={o} actions={<>
                  {o.status === "DISPATCHED" && <><Btn small variant="primary" onClick={() => void call(`${P.purchases}/${o.id}/${P.confirmReceipt}`, undefined, "Received — added to your stock.")}>Received</Btn><Btn small variant="quiet" onClick={() => { const reason = window.prompt("What's wrong with the delivery?"); if (reason) void call(`${P.purchases}/${o.id}/${P.dispute}`, { reason }, "Reported to FastQue."); }}>Report a problem</Btn></>}
                  {o.status === "PLACED" && <Btn small variant="quiet" onClick={() => cancel(`${P.purchases}/${o.id}/${P.cancel}`)}>Cancel</Btn>}
                </>} />
              ))}</tbody></table></div>
          )}
        </Card>
      </div>
    </div>
  );
}
