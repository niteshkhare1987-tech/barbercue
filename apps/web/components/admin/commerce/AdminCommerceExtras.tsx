"use client";

import { useEffect, useState } from "react";
import { COMMERCE_TICKET_STATUSES, type CommerceOrderDto, type CommercePermission, type CommerceTicketDto } from "@barbercue/shared";
import { apiFetch, apiFetchBlob, ApiError } from "../../../lib/api";
import { BarcodeScanner } from "../../owner/inventory/BarcodeScanner";
import { labelPage, poPage, printDocument, slipPage, invoicePage, type InvoiceDto, type PoDocument } from "../../commerce/print";
import ui from "../../owner/owner.module.css";
import css from "../inventory/admin-inventory.module.css";
import c from "./admin-commerce.module.css";
import { ALL, API, Busy, Card, Crud, Form, List, Stats, Table, day, err, inr, productLabel, send, str, useLoad, useOptions, type Field, type Row } from "./parts";

type Can = (p: CommercePermission) => boolean;
async function upload<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append("file", file);
  return apiFetch<T>(`${API}/${path}`, { method: "POST", body });
}
/** Runs one action, shows its error, and reloads afterwards. */
function useAct(reload: () => void) {
  const [error, setError] = useState<string | null>(null);
  const act = (p: Promise<unknown>) =>
    p
      .then(() => {
        setError(null);
        reload();
      })
      .catch((e) => setError(err(e)));
  return { act, error: error && <p className={c.error} role="alert">{error}</p>, setError };
}
const B = ({ children, onClick, main, disabled }: { children: React.ReactNode; onClick: () => void; main?: boolean; disabled?: boolean }) => (
  <button type="button" className={main ? css.verify : css.tab} onClick={onClick} disabled={disabled}>{children}</button>
);

// ---------- Support ----------

export function Support() {
  const [open, setOpen] = useState<(Row & CommerceTicketDto) | null>(null);
  const [n, setN] = useState(0);
  return (
    <>
      {open && <Ticket key={open.id} t={open} onDone={() => { setOpen(null); setN((x) => x + 1); }} />}
      <List
        title="Customer requests"
        path="tickets"
        reloadKey={n}
        statuses={[ALL, ...COMMERCE_TICKET_STATUSES.map((x) => [x, x.toLowerCase().replace("_", " ")] as const)]}
        head={["Request", "Order", "Customer", "About", "Priority", "Status", "Updated", ""]}
        empty="No customer requests."
        row={(r) => [`${str(r, "number")} ${str(r, "subject")}`, `${str(r, "orderNumber")} ${str(r, "productName")}`, `${str(r, "customer")} ${str(r, "phone")}`, str(r, "category").toLowerCase().replace("_", " "), str(r, "priority").toLowerCase(), str(r, "status").toLowerCase().replace("_", " "), day(r.updatedAt), <B key="o" onClick={() => setOpen(r as Row & CommerceTicketDto)}>Open</B>]}
      />
      <Reviews />
    </>
  );
}
function Ticket({ t, onDone }: { t: CommerceTicketDto; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState("");
  const [basis, setBasis] = useState("");
  const { act, error, setError } = useAct(onDone);
  return (
    <Card title={`${t.number}: ${t.subject}`} action={<B onClick={onDone}>Close</B>}>
      {t.messages.map((m) => (
        <p key={m.id} className={m.internal ? c.internal : undefined}>
          <strong>{m.internal ? "Internal note" : m.from === "STAFF" ? "FastQue" : "Customer"}</strong> <small>{new Date(m.createdAt).toLocaleString("en-IN")}</small>
          <br />
          {m.body}
        </p>
      ))}
      {error}
      <label className={c.field}>
        {internal ? "Internal note (the customer never sees it)" : "Reply to the customer"}
        <textarea rows={4} maxLength={3000} value={body} onChange={(e) => setBody(e.target.value)} />
        {basis && <small>Suggested from: {basis} Check it before sending.</small>}
      </label>
      <div className={ui.rowWrap}>
        <label className={c.check}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
        <select className={c.input} aria-label="Set status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Keep status automatic</option>
          {COMMERCE_TICKET_STATUSES.map((x) => <option key={x} value={x}>{x.toLowerCase().replace("_", " ")}</option>)}
        </select>
        <B main disabled={!body.trim() && !status} onClick={() => void act(send(`tickets/${t.id}`, { ...(body.trim() ? { body: body.trim() } : {}), internal, ...(status ? { status } : {}) }))}>Save</B>
        <B onClick={() => void act(send(`tickets/${t.id}`, { assignToMe: true }))}>Assign to me</B>
        <B onClick={() => void act(send(`tickets/${t.id}`, { priority: t.priority === "HIGH" ? "NORMAL" : "HIGH" }))}>{t.priority === "HIGH" ? "Normal priority" : "High priority"}</B>
        <B onClick={() => void apiFetch<{ reply: string; basis: string }>(`${API}/tickets/${t.id}/suggestion`).then((r) => { setBody(r.reply); setBasis(r.basis); }).catch((e) => setError(err(e)))}>Suggest a reply</B>
      </div>
    </Card>
  );
}
function Reviews() {
  const [error, setError] = useState<string | null>(null);
  const set = (r: Row, status: string, reload: () => void) => {
    const reply = status === "PUBLISHED" ? window.prompt("Public reply (optional)", str(r, "reply")) : undefined;
    if (reply === null) return;
    void send(`reviews/${r.id}`, { status, ...(reply ? { reply } : {}) }).then(() => { setError(null); reload(); }).catch((e) => setError(err(e)));
  };
  return (
    <>
      {error && <p className={c.error} role="alert">{error}</p>}
      <List
        title="Reviews"
        path="reviews"
        statuses={[["PENDING", "To check"], ["PUBLISHED", "Published"], ["HIDDEN", "Hidden"]]}
        head={["Product", "By", "Rating", "Review", "When", ""]}
        empty="No reviews here."
        row={(r, reload) => [str(r, "productName"), str(r, "displayName"), `${str(r, "rating")} / 5`, str(r, "body"), day(r.createdAt), <span key="a" className={ui.rowWrap}>{r.status !== "PUBLISHED" && <B main onClick={() => set(r, "PUBLISHED", reload)}>Publish</B>}{r.status !== "HIDDEN" && <B onClick={() => set(r, "HIDDEN", reload)}>Hide</B>}</span>]}
      />
    </>
  );
}

// ---------- Offers, banners, product details ----------

export function Offers({ canEdit }: { canEdit: boolean }) {
  const products = useOptions("listings?limit=100", productLabel);
  const { data, error, load } = useLoad<Row[]>("promotions");
  const [edit, setEdit] = useState<Row | "new" | null>(null);
  const fields: Field[] = [
    { key: "name", label: "Name shown to customers" },
    { key: "kind", label: "Type", type: "select", options: [["BUY_X_GET_Y", "Buy X get Y free"], ["BUNDLE", "Bundle price"], ["PERCENT", "Percent off"]] },
    { key: "listingIds", label: "Products", type: "multi", options: products, hint: "Hold Ctrl to choose several." },
    { key: "buyQty", label: "Buy (X)", type: "number" },
    { key: "getQty", label: "Free (Y)", type: "number" },
    { key: "value", label: "Percent, or bundle price ₹" },
    { key: "pinRules", label: "Only these PIN areas", type: "list", hint: "Empty = everywhere. First digits cover a city." },
    { key: "startsAt", label: "Starts", type: "datetime", optional: true },
    { key: "endsAt", label: "Ends", type: "datetime", optional: true },
    { key: "isActive", label: "Active", type: "checkbox" },
  ];
  const save = async (v: Record<string, unknown>) => {
    const go = (extra = {}) => send(edit === "new" ? "promotions" : `promotions/${(edit as Row).id}`, { ...v, ...extra }, edit === "new" ? "POST" : "PUT");
    try {
      return await go();
    } catch (e) {
      if (e instanceof ApiError && e.code === "COMMERCE_BELOW_COST" && window.confirm(e.message)) return go({ confirmBelowCost: true });
      throw e;
    }
  };
  return (
    <>
      {edit && <Card title="Offer"><Form key={edit === "new" ? "new" : edit.id} fields={fields} initial={edit === "new" ? { kind: "BUY_X_GET_Y", buyQty: 1, getQty: 1, value: "0", isActive: true } : edit} submit={save} label="Save" onDone={() => { setEdit(null); load(); }} /></Card>}
      <Card title="Automatic offers" action={canEdit ? <B main onClick={() => setEdit("new")}>Add offer</B> : null}>
        <p className={ui.hint}>The best offer is applied by the server. One product is never in two offers at once.</p>
        {!data ? <Busy error={error} /> : <Table head={["Offer", "Type", "Products", "Area", "Until", "Active", ""]} empty="No offers yet." rows={data.map((p) => [str(p, "name"), p.kind === "BUY_X_GET_Y" ? `Buy ${str(p, "buyQty")} get ${str(p, "getQty")}` : p.kind === "BUNDLE" ? `Set for ${inr(p.value)}` : `${Number(p.value)}% off`, (p.listingIds as string[]).length, (p.pinRules as string[]).join(", ") || "All", day(p.endsAt), p.isActive ? "Yes" : "No", canEdit ? <B key="e" onClick={() => setEdit(p)}>Edit</B> : null])} />}
      </Card>
      <Crud
        title="Banners"
        path="banners"
        canEdit={canEdit}
        initial={{ linkPath: "/shop/fastque", sortOrder: 100, isActive: true }}
        fields={[{ key: "title", label: "Title" }, { key: "subtitle", label: "Subtitle", optional: true }, { key: "linkPath", label: "Opens", hint: "A shop page, such as /shop/fastque" }, { key: "imageUrl", label: "Image (https)", optional: true }, { key: "sortOrder", label: "Order", type: "number" }, { key: "startsAt", label: "Starts", type: "datetime", optional: true }, { key: "endsAt", label: "Ends", type: "datetime", optional: true }, { key: "isActive", label: "Active", type: "checkbox" }]}
        head={["Title", "Opens", "Until", "Active"]}
        row={(r) => [str(r, "title"), str(r, "linkPath"), day(r.endsAt), r.isActive ? "Yes" : "No"]}
        empty="No banners yet."
      />
    </>
  );
}
export function ProductDetail({ listing, onDone }: { listing: Row; onDone: () => void }) {
  const { data, error } = useLoad<{ detail: Record<string, unknown> | null }>(`listings/${listing.id}/detail`);
  if (!data) return <Busy error={error} />;
  return (
    <Card title={`Details: ${str(listing, "globalProduct.name")}`}>
      <Form
        fields={[
          { key: "benefits", label: "Benefits", type: "area", optional: true },
          { key: "usage", label: "How to use", type: "area", optional: true },
          { key: "ingredients", label: "Ingredients", type: "area", optional: true },
          { key: "warnings", label: "Warnings", type: "area", optional: true },
          { key: "countryOfOrigin", label: "Country of origin", optional: true },
          { key: "manufacturer", label: "Manufacturer and address", optional: true },
          { key: "shelfLifeMonths", label: "Shelf life (months)", type: "number", optional: true },
          { key: "variantGroup", label: "Variant group", optional: true, hint: "Same text on every size or shade of this product." },
          { key: "variantLabel", label: "Variant name", optional: true, hint: "For example 300 ml or Red." },
        ]}
        initial={data.detail ?? {}}
        submit={(v) => send(`listings/${listing.id}/detail`, v, "PUT")}
        label="Save details"
        onDone={onDone}
      />
      <p className={ui.hint}>Copy these from the pack. Empty fields are not shown to customers.</p>
    </Card>
  );
}

// ---------- Stock tools: scan, import, count ----------

export function StockTools({ onFound }: { onFound: (listingId: string) => void }) {
  const [tool, setTool] = useState<"scan" | "import" | "count" | null>(null);
  const alerts = useLoad<{ low: string[]; expiring: string[] }>("stock-alerts");
  const [scanMsg, setScanMsg] = useState("");
  async function scanned(code: string) {
    try {
      const r = await apiFetch<{ items: Row[] }>(`${API}/listings?limit=5&q=${encodeURIComponent(code.replace(/^0+/, ""))}`);
      if (r.items.length !== 1) return setScanMsg(r.items.length ? `${code} matches ${r.items.length} products. Choose one from the list.` : `No FastQue product has the code ${code}.`);
      setScanMsg(`${str(r.items[0], "globalProduct.name")} found.`);
      onFound(r.items[0].id);
    } catch (e) {
      setScanMsg(err(e));
    }
  }
  return (
    <Card title="Stock tools" action={<div className={ui.rowWrap}><B onClick={() => setTool(tool === "scan" ? null : "scan")}>Scan</B><B onClick={() => setTool(tool === "import" ? null : "import")}>Import file</B><B onClick={() => setTool(tool === "count" ? null : "count")}>Stock count</B></div>}>
      {alerts.data && (alerts.data.low.length > 0 || alerts.data.expiring.length > 0) && (
        <>
          {alerts.data.low.length > 0 && <p><strong>Low:</strong> {alerts.data.low.slice(0, 10).join("; ")}{alerts.data.low.length > 10 ? ` and ${alerts.data.low.length - 10} more` : ""}</p>}
          {alerts.data.expiring.length > 0 && <p><strong>Expires within 30 days:</strong> {alerts.data.expiring.slice(0, 10).join("; ")}{alerts.data.expiring.length > 10 ? ` and ${alerts.data.expiring.length - 10} more` : ""}</p>}
        </>
      )}
      {tool === "scan" && <><BarcodeScanner busy={false} onDetected={(x) => void scanned(x)} /><p role="status">{scanMsg}</p></>}
      {tool === "import" && <StockImport />}
      {tool === "count" && <Audits />}
    </Card>
  );
}
interface ImportRow { row: number; code: string; product: string | null; warehouse: string; batchNumber: string; expiresOn: string | null; unitCost: string | null; quantity: number; problems: string[] }
function StockImport() {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<{ rows: ImportRow[]; problems: number; applied: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (f: File, apply: boolean) => {
    setBusy(true);
    upload<NonNullable<typeof res>>(`stock/import?apply=${apply}`, f)
      .then((r) => { setRes(r); setError(null); })
      .catch((e) => setError(err(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <p className={ui.hint}>CSV or Excel with the columns: SKU (or barcode), Warehouse (code), Batch, Expiry, Cost, Qty. Nothing is added until you confirm, and a file with any problem adds nothing.</p>
      <input type="file" aria-label="Stock file" accept=".csv,.xlsx" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setRes(null); if (f) run(f, false); }} />
      {error && <p className={c.error} role="alert">{error}</p>}
      {res && <Table head={["Row", "Product", "Warehouse", "Batch", "Expires", "Cost", "Qty", "Problem"]} empty="" rows={res.rows.slice(0, 200).map((r) => [r.row, r.product ?? r.code, r.warehouse, r.batchNumber, r.expiresOn ?? "—", r.unitCost ?? "—", r.quantity, r.problems.join(", ")])} />}
      {res && !res.applied && file && <B main disabled={busy || res.problems > 0} onClick={() => run(file, true)}>{res.problems ? `${res.problems} row(s) to fix first` : `Add ${res.rows.length} row(s) to stock`}</B>}
      {res?.applied && <p role="status">Added to stock.</p>}
    </>
  );
}
interface Sheet { id: string; number: string; status: string; lines: Array<{ batchId: string; product: string; sku: string; batchNumber: string; location: string | null; counted: number | null; systemQty: number | null; difference: number | null }> }
function Audits() {
  const { data, error, load } = useLoad<Row[]>("audits");
  const warehouses = useOptions("warehouses", (r) => str(r, "name"));
  const [wh, setWh] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const { act, error: problem } = useAct(load);
  const open = (p: Promise<Sheet>) => act(p.then((x) => { setSheet(x); setCounts({}); }));
  const entered = Object.entries(counts).filter(([, v]) => /^\d+$/.test(v)).map(([batchId, v]) => ({ batchId, counted: Number(v) }));
  return (
    <>
      <p className={ui.hint}>The expected quantity is hidden while counting. Someone else must approve the result.</p>
      {problem}
      <div className={ui.rowWrap}>
        <select className={c.input} aria-label="Warehouse to count" value={wh || warehouses[0]?.[0] || ""} onChange={(e) => setWh(e.target.value)}>{warehouses.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <B main disabled={!warehouses.length} onClick={() => void open(send("audits", { warehouseId: wh || warehouses[0][0] }) as Promise<Sheet>)}>Start a count</B>
      </div>
      {sheet && (
        <>
          <h3>{sheet.number}: {sheet.status.toLowerCase()}</h3>
          <Table
            head={["Product", "Batch", "Shelf", "Counted", "System", "Difference"]}
            empty=""
            rows={sheet.lines.map((l) => [
              `${l.product} · ${l.sku}`,
              l.batchNumber,
              l.location ?? "",
              sheet.status === "OPEN" ? <input key="i" className={c.input} type="number" min={0} aria-label={`Counted ${l.product} ${l.batchNumber}`} value={counts[l.batchId] ?? l.counted ?? ""} onChange={(e) => setCounts({ ...counts, [l.batchId]: e.target.value })} /> : l.counted,
              l.systemQty ?? "—",
              l.difference ?? "—",
            ])}
          />
          <div className={ui.rowWrap}>
            {sheet.status === "OPEN" && <B main disabled={!entered.length} onClick={() => void open(send(`audits/${sheet.id}/count`, { lines: entered }, "PUT") as Promise<Sheet>)}>Save count</B>}
            {sheet.status === "SUBMITTED" && <B main onClick={() => void act((send(`audits/${sheet.id}/approve`, {}) as Promise<{ problems: string[]; approved: boolean }>).then((r) => { if (!r.approved) throw new ApiError(409, { error: { code: "COMMERCE_AUDIT", message: r.problems.join(" ") } }); setSheet(null); }))}>Approve and post differences</B>}
            {["OPEN", "SUBMITTED"].includes(sheet.status) && <B onClick={() => void act(send(`audits/${sheet.id}/cancel`, {}).then(() => setSheet(null)))}>Cancel count</B>}
          </div>
        </>
      )}
      {!data ? <Busy error={error} /> : <Table head={["Count", "Batches", "Started", "Status", ""]} empty="No counts yet." rows={data.map((a) => [str(a, "number"), str(a, "_count.lines"), day(a.createdAt), str(a, "status").toLowerCase(), <B key="o" onClick={() => void open(apiFetch<Sheet>(`${API}/audits/${a.id}`))}>Open</B>])} />}
    </>
  );
}

// ---------- COD settlement files ----------

export function Settlements() {
  const { data, error, load } = useLoad<Array<Row & { lines: Array<{ id: string; rowNumber: number; matchText: string; amount: string; deductions: string; state: string; message: string | null }> }>>("settlements");
  const [courier, setCourier] = useState("");
  const { act, error: problem } = useAct(load);
  return (
    <Card title="Courier settlement files">
      <p className={ui.hint}>CSV or Excel with an order or tracking number and an amount; deductions and UTR are optional. Matched lines are recorded only when you apply them. Each order is still signed off separately.</p>
      {problem}
      <div className={ui.rowWrap}>
        <input className={c.input} aria-label="Courier" placeholder="Courier name" value={courier} onChange={(e) => setCourier(e.target.value)} />
        <input type="file" aria-label="Settlement file" accept=".csv,.xlsx" disabled={courier.trim().length < 2} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void act(upload(`settlements?courier=${encodeURIComponent(courier.trim())}`, f)); }} />
      </div>
      {!data ? <Busy error={error} /> : data.length === 0 ? <p className={ui.hint}>No files yet.</p> : data.map((i) => {
        const ready = i.lines.filter((l) => l.state === "MATCHED").length;
        return (
          <details key={i.id} open={ready > 0}>
            <summary>{str(i, "courier")} · {str(i, "fileName")} · {day(i.createdAt)} · {i.lines.filter((l) => l.state === "APPLIED").length} recorded, {ready} ready, {i.lines.filter((l) => l.state === "PROBLEM").length} to check</summary>
            {ready > 0 && <B main onClick={() => void act(send(`settlements/${i.id}/apply`, {}))}>Record {ready} matched line(s)</B>}
            <Table head={["Row", "Order / tracking", "Amount", "Deductions", "Result", "Note"]} empty="" rows={i.lines.map((l) => [l.rowNumber, l.matchText, inr(l.amount), inr(l.deductions), l.state.toLowerCase(), l.message ?? ""])} />
          </details>
        );
      })}
    </Card>
  );
}

// ---------- Procurement ----------

interface Quote { id: string; supplier: string; unitCost: string; leadTimeDays: number | null; validUntil: string | null }
export function Requests({ can, onOrdered }: { can: Can; onOrdered: () => void }) {
  const { data, error, load } = useLoad<Array<Row & { quotations: Quote[] }>>("purchase-requests");
  const products = useOptions("listings?limit=100", productLabel);
  const warehouses = useOptions("warehouses", (r) => str(r, "name"));
  const suppliers = useOptions("suppliers", (r) => str(r, "name"));
  const [adding, setAdding] = useState(false);
  const [quoteFor, setQuoteFor] = useState<Row | null>(null);
  const { act, error: problem } = useAct(load);
  const done = () => { setAdding(false); setQuoteFor(null); load(); };
  return (
    <>
      {problem}
      {adding && <Card title="Ask for stock"><Form fields={[{ key: "listingId", label: "Product", type: "select", options: products }, { key: "warehouseId", label: "For", type: "select", options: warehouses }, { key: "quantity", label: "Quantity", type: "number" }, { key: "reason", label: "Why" }]} initial={{ listingId: products[0]?.[0], warehouseId: warehouses[0]?.[0] }} submit={(v) => send("purchase-requests", v)} label="Send request" onDone={done} /></Card>}
      {quoteFor && <Card title={`Quotation for ${str(quoteFor, "product")}`}><Form fields={[{ key: "supplierId", label: "Supplier", type: "select", options: suppliers }, { key: "unitCost", label: "Unit cost ₹" }, { key: "leadTimeDays", label: "Lead time (days)", type: "number", optional: true }, { key: "validUntil", label: "Valid until", type: "date", optional: true }, { key: "note", label: "Note", optional: true }]} initial={{ supplierId: suppliers[0]?.[0] }} submit={(v) => send(`purchase-requests/${quoteFor.id}/quotations`, v)} label="Save quotation" onDone={done} /></Card>}
      <Card title="Purchase requests" action={can("warehouse") ? <B main onClick={() => setAdding(true)}>Ask for stock</B> : null}>
        {!data ? <Busy error={error} /> : (
          <Table
            head={["Request", "Product", "Qty", "Why", "Quotations", "Status", ""]}
            empty="No requests yet."
            rows={data.map((r) => [
              str(r, "number"),
              str(r, "product"),
              str(r, "quantity"),
              str(r, "reason"),
              r.quotations.length ? r.quotations.map((q) => <div key={q.id}>{q.supplier}: {inr(q.unitCost)}{q.leadTimeDays != null ? `, ${q.leadTimeDays} days` : ""} {r.status === "APPROVED" && <B main onClick={() => void act(send(`purchase-requests/${r.id}/action`, { action: "ORDER", quotationId: q.id }).then(onOrdered))}>Order</B>}</div>) : "—",
              str(r, "status").toLowerCase(),
              <span key="a" className={ui.rowWrap}>
                {["OPEN", "APPROVED"].includes(str(r, "status")) && <B onClick={() => setQuoteFor(r)}>Add quotation</B>}
                {r.status === "OPEN" && can("finance") && <><B main onClick={() => void act(send(`purchase-requests/${r.id}/action`, { action: "APPROVE" }))}>Approve</B><B onClick={() => void act(send(`purchase-requests/${r.id}/action`, { action: "REJECT" }))}>Reject</B></>}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
export const printPo = (id: string) => apiFetch<PoDocument>(`${API}/purchase-orders/${id}/document`).then((d) => printDocument(d.number, [poPage(d)]));
export function SupplierReturns({ can }: { can: Can }) {
  const { data, error, load } = useLoad<Row[]>("supplier-returns");
  const suppliers = useOptions("suppliers", (r) => str(r, "name"));
  const batches = useOptions("batches?limit=100", (r) => `${str(r, "listing.globalProduct.name")} · ${str(r, "batchNumber")} (${str(r, "onHand")} on hand, ${str(r, "damaged")} damaged)`);
  const [adding, setAdding] = useState(false);
  const [credit, setCredit] = useState<Row | null>(null);
  const done = () => { setAdding(false); setCredit(null); load(); };
  return (
    <>
      {adding && <Card title="Send stock back to a supplier"><Form fields={[{ key: "supplierId", label: "Supplier", type: "select", options: suppliers }, { key: "batchId", label: "Batch", type: "select", options: batches }, { key: "source", label: "Take from", type: "select", options: [["DAMAGED", "Damaged"], ["ON_HAND", "Sellable stock"], ["QUARANTINED", "Quarantine"], ["EXPIRED", "Expired"]] }, { key: "quantity", label: "Quantity", type: "number" }, { key: "reason", label: "Reason" }]} initial={{ supplierId: suppliers[0]?.[0], batchId: batches[0]?.[0] }} submit={(v) => send("supplier-returns", v, "POST", true)} label="Send back" onDone={done} /></Card>}
      {credit && <Card title={`Credit for ${str(credit, "number")}`}><Form fields={[{ key: "amount", label: "Credit received ₹" }, { key: "reference", label: "Credit note", optional: true }]} submit={(v) => send(`supplier-returns/${credit.id}/credit`, v)} label="Record credit" onDone={done} /></Card>}
      <Card title="Returns to suppliers" action={<B main onClick={() => setAdding(true)}>Return stock</B>}>
        {!data ? <Busy error={error} /> : <Table head={["Return", "Supplier", "Product", "Qty", "Reason", "Status", "Credit", ""]} empty="No supplier returns." rows={data.map((r) => [str(r, "number"), str(r, "supplier"), `${str(r, "product")} · ${str(r, "batchNumber")}`, str(r, "quantity"), str(r, "reason"), str(r, "status").toLowerCase(), r.creditAmount ? inr(r.creditAmount) : "—", r.status === "SENT" && can("finance") ? <B key="c" onClick={() => setCredit(r)}>Record credit</B> : null])} />}
      </Card>
    </>
  );
}

// ---------- Orders: bulk, documents, proof, pickups ----------

const orderPages = (ids: string[], page: (o: CommerceOrderDto) => string, title: string) =>
  Promise.all(ids.map((id) => apiFetch<CommerceOrderDto>(`${API}/orders/${id}`))).then((all) => printDocument(title, all.map(page)));
export function BulkOrders({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState("PLACED");
  const { data, error, load } = useLoad<{ items: Row[] }>(`orders?limit=100&status=${status}`);
  const [picked, setPicked] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const { act, error: problem } = useAct(() => { load(); onChanged(); });
  const NEXT: Record<string, Array<[string, string]>> = { PLACED: [["CONFIRMED", "Confirm"]], CONFIRMED: [["PROCESSING", "Start preparing"], ["PACKED", "Mark packed"]], PROCESSING: [["PACKED", "Mark packed"]], PACKED: [], SHIPPED: [["OUT_FOR_DELIVERY", "Out for delivery"]] };
  const bulk = (to: string) =>
    act(
      (send("orders-bulk", { orderIds: picked, to }) as Promise<{ done: number; results: Array<{ orderId: string; ok: boolean; message?: string }> }>).then((r) => {
        const bad = r.results.filter((x) => !x.ok);
        setMsg(`${r.done} order(s) changed.${bad.length ? ` ${bad.length} not: ${[...new Set(bad.map((x) => x.message))].join(" ")}` : ""}`);
        setPicked(bad.map((x) => x.orderId));
      }),
    );
  const choose = (v: string) => { setStatus(v); setPicked([]); setMsg(""); };
  return (
    <Card title="Several orders at once" action={<select className={c.input} aria-label="Orders that are" value={status} onChange={(e) => choose(e.target.value)}>{Object.keys(NEXT).map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}</select>}>
      {problem}
      <p role="status">{msg}</p>
      <div className={ui.rowWrap}>
        {NEXT[status].map(([to, label]) => <B key={to} main disabled={!picked.length} onClick={() => void bulk(to)}>{label} ({picked.length})</B>)}
        <B disabled={!picked.length} onClick={() => void act(orderPages(picked, slipPage, "Packing slips"))}>Packing slips</B>
        <B disabled={!picked.length} onClick={() => void act(orderPages(picked, labelPage, "Address labels"))}>Address labels</B>
        <B disabled={!picked.length} onClick={() => void act(Promise.all(picked.map((id) => apiFetch<InvoiceDto>(`${API}/orders/${id}/invoice`))).then((all) => printDocument("Bills", all.map(invoicePage))))}>Bills</B>
        {data && data.items.length > 0 && <B onClick={() => setPicked(picked.length ? [] : data.items.map((x) => x.id))}>{picked.length ? "Clear" : "Select all"}</B>}
      </div>
      {!data ? <Busy error={error} /> : <Table head={["", "Order", "Customer", "City", "Total"]} empty="No orders in this state." rows={data.items.map((o) => [<input key="c" type="checkbox" aria-label={`Select ${str(o, "orderNumber")}`} checked={picked.includes(o.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))} />, str(o, "orderNumber"), str(o, "contactName"), str(o, "shippingAddress.city"), inr(o.total)])} />}
    </Card>
  );
}
export function OrderFiles({ orderId, canAdd }: { orderId: string; canAdd: boolean }) {
  const { data, load } = useLoad<Array<{ id: string; kind: string; createdAt: string }>>(`orders/${orderId}/files`);
  const { act, error } = useAct(load);
  return (
    <>
      <h3>Photos</h3>
      {error}
      {data?.length ? <div className={ui.rowWrap}>{data.map((f) => <Photo key={f.id} id={f.id} label={f.kind === "RETURN_PHOTO" ? "Return photo" : "Delivery proof"} />)}</div> : <p className={ui.hint}>No photos.</p>}
      {canAdd && <label className={c.field}>Add delivery proof<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void act(upload(`orders/${orderId}/proof`, f)); }} /></label>}
    </>
  );
}
function Photo({ id, label }: { id: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let live = true;
    apiFetchBlob(`${API}/files/${id}`)
      .then(({ blob }) => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  // eslint-disable-next-line @next/next/no-img-element -- private photo from a blob URL
  return url ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt={label} className={c.photo} /></a> : null;
}
export function Pickups() {
  const { data, error, load } = useLoad<Row[]>("pickups");
  const packed = useLoad<{ items: Row[] }>("orders?limit=100&status=PACKED");
  const warehouses = useOptions("warehouses", (r) => str(r, "name"));
  const [adding, setAdding] = useState(false);
  const { act, error: problem } = useAct(load);
  return (
    <>
      {problem}
      {adding && (
        <Card title="Book a pickup">
          <p className={ui.hint}>This records a pickup you arrange with the courier. No courier is contacted automatically.</p>
          <Form
            fields={[{ key: "warehouseId", label: "From", type: "select", options: warehouses }, { key: "courier", label: "Courier" }, { key: "pickupOn", label: "Date", type: "date" }, { key: "window", label: "Time", optional: true }, { key: "orderIds", label: "Packed orders", type: "multi", options: (packed.data?.items ?? []).map((o) => [o.id, str(o, "orderNumber")] as const) }, { key: "note", label: "Note", optional: true }]}
            initial={{ warehouseId: warehouses[0]?.[0] }}
            submit={(v) => send("pickups", v)}
            label="Book"
            onDone={() => { setAdding(false); load(); }}
          />
        </Card>
      )}
      <Card title="Pickups" action={<B main onClick={() => setAdding(true)}>Book pickup</B>}>
        {!data ? <Busy error={error} /> : <Table head={["Pickup", "Courier", "Date", "Orders", "Status", ""]} empty="No pickups yet." rows={data.map((p) => [str(p, "number"), str(p, "courier"), `${day(p.pickupOn)} ${str(p, "window")}`, (p.orderIds as string[]).length, str(p, "status").toLowerCase().replace("_", " "), p.status === "SCHEDULED" ? <span key="a" className={ui.rowWrap}><B main onClick={() => void act(send(`pickups/${p.id}`, { status: "PICKED_UP" }))}>Picked up</B><B onClick={() => void act(send(`pickups/${p.id}`, { status: "CANCELLED" }))}>Cancel</B></span> : null])} />}
      </Card>
    </>
  );
}

// ---------- Forecast, suggestions, reports ----------

const off = (e: string | null) => e?.includes("not found");
export function Forecasts({ can }: { can: Can }) {
  const f = useLoad<Array<{ listingId: string; product: string; available: number; daysOfStock: number | null; suggestedOrder: number | null; note: string; forecast: { weeklyAverage: number; low: number; high: number } | null }>>(can("procurement") ? "forecast" : null);
  const p = useLoad<Array<{ listingId: string; product: string; currentPrice: string; suggestedPrice: string; reason: string }>>(can("finance") ? "price-suggestions" : null);
  const r = useLoad<Array<{ kind: string; who: string; message: string }>>(can("support") ? "risk-signals" : null);
  if (off(f.error) || off(p.error) || off(r.error)) return null;
  return (
    <>
      {can("procurement") && <Card title="Demand forecast">{!f.data ? <Busy error={f.error} /> : <Table head={["Product", "Available", "Weekly sales", "Days of stock", "Suggested order", "Based on"]} empty="No products." rows={f.data.map((x) => [x.product, x.available, x.forecast ? `${x.forecast.weeklyAverage} (${x.forecast.low}–${x.forecast.high})` : "—", x.daysOfStock ?? "—", x.suggestedOrder ?? "—", x.note])} />}</Card>}
      {can("finance") && <Card title="Price suggestions"><p className={ui.hint}>Nothing changes until someone edits the product.</p>{!p.data ? <Busy error={p.error} /> : <Table head={["Product", "Now", "Suggested", "Why"]} empty="Nothing to suggest." rows={p.data.map((x) => [x.product, inr(x.currentPrice), inr(x.suggestedPrice), x.reason])} />}</Card>}
      {can("support") && <Card title="Orders to look at"><p className={ui.hint}>Patterns only. A person decides; no customer is blocked.</p>{!r.data ? <Busy error={r.error} /> : <Table head={["Pattern", "Who", "What"]} empty="No unusual patterns." rows={r.data.map((x) => [x.kind.toLowerCase().replace("_", " "), x.who, x.message])} />}</Card>}
    </>
  );
}
interface ReportDto {
  retention: Array<{ month: string; customers: number; orderedAgain: number; rate: string | null }>;
  customerValue: { customers: number; ordersEach: string | null; spendEach: string | null; basis: string } | null;
  warehouses: Array<{ code: string; name: string; orders: number; delivered: number; hoursToShip: string | null; stockValue: string | null }>;
  funnel: { productViews: number; bagViews: number; checkoutsStarted: number; orders: number; ordersPerProductView: string | null; basis: string };
  abandonedBags: { count: number; basis: string };
  tickets: Record<string, number>;
}
export function MoreReports() {
  const { data, error } = useLoad<ReportDto>("reports?limit=25");
  if (!data) return <Busy error={error} />;
  return (
    <>
      <Card title="From view to order (last 30 days)">
        <Stats items={[["Product views", data.funnel.productViews], ["Bag views", data.funnel.bagViews], ["Checkouts started", data.funnel.checkoutsStarted], ["Orders", data.funnel.orders], ["Orders per product view", data.funnel.ordersPerProductView ? `${data.funnel.ordersPerProductView}%` : "—"], ["Abandoned bags", data.abandonedBags.count]]} />
        <p className={ui.hint}>{data.funnel.basis} {data.abandonedBags.basis}</p>
      </Card>
      <Card title="Customers who come back"><Table head={["First order in", "Customers", "Ordered again", "Share"]} empty="No orders yet." rows={data.retention.map((r) => [r.month, r.customers, r.orderedAgain, r.rate ? `${r.rate}%` : "—"])} /></Card>
      {data.customerValue && <Card title="Value per customer"><Stats items={[["Customers", data.customerValue.customers], ["Orders each", data.customerValue.ordersEach ?? "—"], ["Spend each", data.customerValue.spendEach ? inr(data.customerValue.spendEach) : "—"]]} /><p className={ui.hint}>{data.customerValue.basis}</p></Card>}
      <Card title="Warehouses"><Table head={["Warehouse", "Orders", "Delivered", "Hours to ship", "Stock value"]} empty="No warehouses." rows={data.warehouses.map((w) => [`${w.code} ${w.name}`, w.orders, w.delivered, w.hoursToShip ?? "—", w.stockValue ? inr(w.stockValue) : "—"])} /></Card>
      <Card title="Support requests"><Stats items={Object.entries(data.tickets).map(([k, v]) => [k.toLowerCase().replace("_", " "), v])} /></Card>
    </>
  );
}
export async function downloadXlsx() {
  const { blob } = await apiFetchBlob(`${API}/export/orders-xlsx?limit=25`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fastque-orders.xlsx";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Settings ----------

export function MoreSettings() {
  const policies = useLoad<Row[]>("return-policies");
  const grants = useLoad<Array<{ userId: string; warehouseId: string }>>("warehouse-grants");
  const people = useLoad<Array<{ userId: string; email: string | null; permissions: string[] }>>("grants");
  const warehouses = useOptions("warehouses", (r) => str(r, "code"));
  const [n, setN] = useState(0);
  const { act, error } = useAct(grants.load);
  return (
    <>
      <Card title="Return rules by category">
        <p className={ui.hint}>The stricter of this rule and the product&apos;s own rule applies, and is fixed on the order when it is placed.</p>
        <Form key={n} fields={[{ key: "category", label: "Category" }, { key: "windowDays", label: "Days", type: "number" }, { key: "returnable", label: "Can be returned", type: "checkbox" }, { key: "note", label: "Note", optional: true }]} initial={{ returnable: true, windowDays: 7 }} submit={(v) => send("return-policies", v, "PUT")} label="Save rule" onDone={() => { policies.load(); setN((x) => x + 1); }} />
        {policies.data && <Table head={["Category", "Returns", "Days", "Note"]} empty="No category rules." rows={policies.data.map((p) => [str(p, "category"), p.returnable ? "Yes" : "No", str(p, "windowDays"), str(p, "note")])} />}
      </Card>
      <Card title="Warehouse limits">
        <p className={ui.hint}>Nothing ticked = all warehouses. Tick some to limit a person&apos;s stock work to them.</p>
        {error}
        {people.data && grants.data && (
          <Table
            head={["Person", ...warehouses.map((w) => w[1])]}
            empty="No staff with warehouse permission."
            rows={people.data.filter((p) => p.permissions.includes("warehouse")).map((p) => {
              const mine = grants.data!.filter((g) => g.userId === p.userId).map((g) => g.warehouseId);
              return [p.email ?? p.userId, ...warehouses.map(([id, code]) => <input key={id} type="checkbox" aria-label={`${code} for ${p.email ?? p.userId}`} checked={mine.includes(id)} onChange={(e) => void act(send("warehouse-grants", { userId: p.userId, warehouseIds: e.target.checked ? [...mine, id] : mine.filter((x) => x !== id) }, "PUT"))} />)];
            })}
          />
        )}
      </Card>
    </>
  );
}
