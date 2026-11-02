"use client";

import { useEffect, useState } from "react";
import {
  COMMERCE_PATHS as P,
  DISCOVERY_PATHS,
  type CityDto,
  type MarketplaceSupplierDto,
  type PurchaseOrderDto,
  type SupplierOfferDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { moneyText, trimDecimal } from "../../lib/inventory";
import { Badge, Banner, Btn, Card, EmptyState, Field, Skeleton } from "../owner/parts";
import ui from "../owner/owner.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const rupees = (v: string | number) => moneyText(String(v), "INR");
const root = P.supplierRoot;

function Apply({ onDone }: { onDone: (s: MarketplaceSupplierDto) => void }) {
  const [cities, setCities] = useState<CityDto[]>([]);
  const [f, setF] = useState({ name: "", legalName: "", gstin: "", contactName: "", phone: "", email: "", address: "", cityId: "", serviceCityIds: [] as string[], lead: "3", delivery: "0", freeAbove: "", minOrder: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<CityDto[]>(DISCOVERY_PATHS.cities).then(setCities).catch(() => undefined);
  }, []);
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  async function submit() {
    setError(null);
    try {
      onDone(
        await apiFetch<MarketplaceSupplierDto>(`${root}/${P.apply}`, {
          method: "POST",
          body: JSON.stringify({
            name: f.name, legalName: f.legalName || null, gstin: f.gstin || null, contactName: f.contactName, phone: f.phone, email: f.email, address: f.address,
            cityId: f.cityId, serviceCityIds: f.serviceCityIds.length ? f.serviceCityIds : f.cityId ? [f.cityId] : [],
            defaultLeadTimeDays: Number(f.lead), deliveryCharge: Number(f.delivery) || 0, freeDeliveryAbove: num(f.freeAbove), minimumOrderValue: num(f.minOrder),
          }),
        }),
      );
    } catch (e) {
      setError(errorText(e, "Your application was not sent. Check the fields."));
    }
  }
  const field = (label: string, key: keyof typeof f, extra: { hint?: string; inputMode?: "numeric" | "decimal" | "email" | "tel" } = {}) => (
    <Field label={label} htmlFor={`sup-${key}`} hint={extra.hint}>
      <input id={`sup-${key}`} className={ui.input} inputMode={extra.inputMode} value={f[key] as string} onChange={(e) => set({ [key]: e.target.value } as Partial<typeof f>)} />
    </Field>
  );
  return (
    <Card title="Become a FastQue supplier" sub="Sell your products to salons on FastQue. FastQue reviews every application before your catalog is shown to salons. FastQue does not hold stock or take payments — salons pay you on your invoice.">
      <div className={ui.rowWrap}>{field("Business name", "name")}{field("Legal name (optional)", "legalName")}{field("GSTIN (optional)", "gstin")}</div>
      <div className={ui.rowWrap}>{field("Contact person", "contactName")}{field("Phone", "phone", { inputMode: "tel" })}{field("Email", "email", { inputMode: "email" })}</div>
      {field("Address", "address")}
      <div className={ui.rowWrap}>
        <Field label="City" htmlFor="sup-city"><select id="sup-city" className={ui.input} value={f.cityId} onChange={(e) => set({ cityId: e.target.value })}><option value="">Choose…</option>{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Cities you deliver to" htmlFor="sup-cities" hint="Hold Ctrl to pick several. Empty = your city."><select id="sup-cities" multiple className={ui.input} style={{ minHeight: 90 }} value={f.serviceCityIds} onChange={(e) => set({ serviceCityIds: Array.from(e.target.selectedOptions).map((o) => o.value) })}>{cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      </div>
      <div className={ui.rowWrap}>{field("Delivery takes (days)", "lead", { inputMode: "numeric" })}{field("Delivery charge (₹)", "delivery", { inputMode: "decimal" })}{field("Free delivery above (₹)", "freeAbove", { inputMode: "decimal" })}{field("Minimum order (₹)", "minOrder", { inputMode: "decimal" })}</div>
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}><Btn variant="primary" onClick={() => void submit()}>Send application</Btn></div>
    </Card>
  );
}

function PriceList() {
  const [offers, setOffers] = useState<SupplierOfferDto[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; brand: string | null; barcode: string | null }[]>([]);
  const [draft, setDraft] = useState<{ globalProductId: string; name: string; price: string; moq: string; available: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ headerErrors: string[]; summary: Record<string, number>; rows: { line: number; barcode: string; status: string; errors: string[] }[] } | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = () => void apiFetch<SupplierOfferDto[]>(`${root}/${P.offers}`).then(setOffers).catch((e) => setMsg({ tone: "error", text: errorText(e, "Could not load.") }));
  useEffect(load, []);
  async function search() {
    setFound(await apiFetch<{ id: string; name: string; brand: string | null; barcode: string | null }[]>(`${root}/catalog-search?q=${encodeURIComponent(q)}`).catch(() => []));
  }
  async function save(body: Record<string, unknown>) {
    setMsg(null);
    try {
      await apiFetch(`${root}/${P.offers}`, { method: "PUT", body: JSON.stringify(body) });
      setDraft(null);
      setMsg({ tone: "ok", text: "Saved." });
      load();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "Not saved.") });
    }
  }
  async function csv(step: "preview" | "commit") {
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    try {
      if (step === "preview") setPreview(await apiFetch(`${root}/${P.offersImportPreview}`, { method: "POST", body }));
      else {
        const r = await apiFetch<{ saved: number; skipped: number }>(`${root}/${P.offersImportCommit}`, { method: "POST", body });
        setMsg({ tone: "ok", text: `Saved ${r.saved} prices; ${r.skipped} rows skipped.` });
        setPreview(null);
        load();
      }
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e, "The file was not processed.") });
    }
  }
  return (
    <Card title="Price list" sub="Prices per piece of products verified in the FastQue catalog. Leave stock empty if you don't want to share it — salons are then told it's unconfirmed.">
      {msg && <Banner tone={msg.tone === "ok" ? "ok" : "error"}>{msg.text}</Banner>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <Field label="Add a product (name, brand or barcode)" htmlFor="sup-q"><input id="sup-q" className={ui.input} value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Btn onClick={() => void search()}>Search</Btn>
      </div>
      {found.map((p) => <div key={p.id} className={ui.mt12}>{p.name} <span className={ui.hint}>{[p.brand, p.barcode].filter(Boolean).join(" · ")}</span> <Btn small onClick={() => setDraft({ globalProductId: p.id, name: p.name, price: "", moq: "1", available: "" })}>Set price</Btn></div>)}
      {draft && (
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          <strong>{draft.name}</strong>
          <Field label="Price (₹)" htmlFor="sup-price"><input id="sup-price" className={ui.input} style={{ width: 90 }} inputMode="decimal" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></Field>
          <Field label="Min order" htmlFor="sup-moq"><input id="sup-moq" className={ui.input} style={{ width: 80 }} inputMode="numeric" value={draft.moq} onChange={(e) => setDraft({ ...draft, moq: e.target.value })} /></Field>
          <Field label="In stock (optional)" htmlFor="sup-avail"><input id="sup-avail" className={ui.input} style={{ width: 90 }} inputMode="numeric" value={draft.available} onChange={(e) => setDraft({ ...draft, available: e.target.value })} /></Field>
          <Btn variant="primary" onClick={() => void save({ globalProductId: draft.globalProductId, unitPrice: Math.round(Number(draft.price) * 100) / 100, minOrderQuantity: Number(draft.moq) || 1, availableQuantity: draft.available.trim() === "" ? null : Number(draft.available) })}>Save</Btn>
        </div>
      )}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <label className={ui.label}>Upload a price list (CSV: barcode, supplier_sku, price, min_order, available, lead_time_days) <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} /></label>
        <Btn small disabled={!file} onClick={() => void csv("preview")}>Check file</Btn>
      </div>
      {preview && (
        <div className={ui.mt12}>
          {preview.headerErrors.length ? <Banner tone="error">{preview.headerErrors.join(" ")}</Banner> : (
            <>
              <p className={ui.cardSub}>{preview.summary.OK} ready · {preview.summary.UNKNOWN_PRODUCT} not in the FastQue catalog · {preview.summary.INVALID} with errors · {preview.summary.DUPLICATE_IN_FILE} repeated</p>
              {preview.rows.filter((r) => r.status !== "OK").slice(0, 20).map((r) => <div key={r.line} className={ui.hint}>Line {r.line} ({r.barcode}): {r.errors.join(" ")}</div>)}
              {preview.summary.OK > 0 && <Btn variant="primary" onClick={() => void csv("commit")}>Save {preview.summary.OK} prices</Btn>}
            </>
          )}
        </div>
      )}
      {!offers ? <Skeleton height={60} /> : offers.length === 0 ? <EmptyState title="No prices yet" /> : (
        <div className={`${ui.tableWrap} ${ui.mt12}`}>
          <table className={ui.table}>
            <thead><tr><th>Product</th><th className={ui.num}>Price</th><th className={ui.num}>Min order</th><th className={ui.num}>In stock</th><th>Shown to salons</th></tr></thead>
            <tbody>{offers.map((o) => (
              <tr key={o.id}><td>{o.productName}<div className={ui.hint}>{[o.brand, o.barcode, o.supplierSku].filter(Boolean).join(" · ")}</div></td><td className={ui.num}>{rupees(o.unitPrice)}</td><td className={ui.num}>{o.minOrderQuantity}</td><td className={ui.num}>{o.availableQuantity ?? "—"}</td>
                <td><label className={ui.label}><input type="checkbox" checked={o.isActive} onChange={(e) => void save({ globalProductId: o.globalProductId, unitPrice: Number(o.unitPrice), minOrderQuantity: o.minOrderQuantity, availableQuantity: o.availableQuantity, leadTimeDays: o.leadTimeDays, isActive: e.target.checked })} /> {o.isActive ? "Yes" : "No"}</label></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Orders() {
  const [orders, setOrders] = useState<PurchaseOrderDto[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => void apiFetch<PurchaseOrderDto[]>(`${root}/${P.supplierOrders}`).then(setOrders).catch((e) => setMsg(errorText(e, "Could not load.")));
  useEffect(load, []);
  async function act(id: string, action: "confirm" | "reject" | "dispatch") {
    const note = action === "reject" ? window.prompt("Tell the salon why:") : action === "confirm" ? window.prompt("Expected delivery date (YYYY-MM-DD), optional:") : null;
    if (action === "reject" && !note) return;
    try {
      await apiFetch(`${root}/${P.supplierOrders}/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "confirm" ? (note && /^\d{4}-\d{2}-\d{2}$/.test(note) ? { expectedDeliveryDate: note } : {}) : action === "reject" ? { note } : {}),
      });
      load();
    } catch (e) {
      setMsg(errorText(e, "That did not work."));
    }
  }
  return (
    <Card title="Orders from salons" sub="Confirm, dispatch or decline. The salon's stock goes up only when they receive and count the goods.">
      {msg && <Banner tone="error">{msg}</Banner>}
      {!orders ? <Skeleton height={60} /> : orders.length === 0 ? <EmptyState title="No orders yet" /> : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead><tr><th>Order</th><th>Salon</th><th>Items</th><th className={ui.num}>Total</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id}><td>{o.number}<div className={ui.hint}>{o.placedAt?.slice(0, 10)}</div></td><td>{o.salonName}</td><td>{o.items.map((i) => `${trimDecimal(i.quantity)} × ${i.name}`).join(", ")}</td><td className={ui.num}>{rupees(o.total)}</td><td><Badge tone={o.status === "REJECTED" || o.status === "CANCELLED" ? "bad" : o.status === "RECEIVED" ? "ok" : "info"}>{o.status.toLowerCase().replace(/_/g, " ")}</Badge></td>
                <td className={ui.rowWrap}>{o.status === "PLACED" && <Btn small variant="primary" onClick={() => void act(o.id, "confirm")}>Confirm</Btn>}{o.status === "CONFIRMED" && <Btn small variant="primary" onClick={() => void act(o.id, "dispatch")}>Dispatched</Btn>}{["PLACED", "CONFIRMED"].includes(o.status) && <Btn small variant="quiet" onClick={() => void act(o.id, "reject")}>Decline</Btn>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Supplier portal: apply → wait for FastQue → manage the price list and incoming orders. */
export function SupplierPortal() {
  const [me, setMe] = useState<MarketplaceSupplierDto | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void apiFetch<MarketplaceSupplierDto | null>(`${root}/${P.me}`).then((s) => setMe(s ?? null)).catch((e) => setError(errorText(e, "Could not load.")));
  }, []);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (me === undefined) return <Skeleton height={160} />;
  if (!me) return <Apply onDone={setMe} />;
  if (me.status !== "APPROVED")
    return (
      <Card title={me.name}>
        <Banner tone={me.status === "PENDING" ? "info" : "warn"}>
          {me.status === "PENDING" ? "Thanks — FastQue is reviewing your application. Your price list opens once you're approved." : `This supplier account is ${me.status.toLowerCase()}.${me.reviewNote ? ` FastQue: ${me.reviewNote}` : ""}`}
        </Banner>
      </Card>
    );
  return (
    <>
      <Card title={me.name} sub={`Approved FastQue supplier · delivers in ${me.defaultLeadTimeDays} days · delivery ${rupees(me.deliveryCharge)}${me.freeDeliveryAbove ? `, free above ${rupees(me.freeDeliveryAbove)}` : ""}`}>{null}</Card>
      <div className={ui.mt16}><Orders /></div>
      <div className={ui.mt16}><PriceList /></div>
    </>
  );
}
