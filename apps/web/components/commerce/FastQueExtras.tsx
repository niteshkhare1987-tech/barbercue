"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { COMMERCE_TICKET_CATEGORIES, type CommerceAddressInput, type CommerceBannerDto, type CommerceOrderDto, type CommerceProductDto, type CommerceReviewsDto, type CommerceTicketDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { fqBag, lineOf, rememberViewed, useCommerceConfig, useFqBag, useFqViewed } from "../../lib/commerce/store";
import { rupees } from "../shop/ShopParts";
import { errText, FastQueGrid } from "./CommerceParts";
import { invoicePage, printDocument, type InvoiceDto } from "./print";
import s from "../shop/shop.module.css";
import c from "./commerce.module.css";

const stars = (n: number) => "★★★★★".slice(0, Math.round(n)) + "☆☆☆☆☆".slice(0, 5 - Math.round(n));
export function Stars({ average, count }: { average: number; count: number }) {
  return (
    <span className={c.stars}>
      <span aria-hidden="true">{stars(average)}</span> <span>{average} ({count} {count === 1 ? "review" : "reviews"})</span>
    </span>
  );
}
/** An anonymous page counter; failures are ignored and nothing about the person is sent. */
export const countPage = (metric: "PRODUCT_VIEW" | "BAG_VIEW" | "CHECKOUT_START") => void apiFetch("commerce/events", { method: "POST", body: JSON.stringify({ metric }) }).catch(() => undefined);

// ---------- Product page ----------

interface Extras {
  ingredients: string | null;
  usage: string | null;
  benefits: string | null;
  warnings: string | null;
  countryOfOrigin: string | null;
  manufacturer: string | null;
  shelfLifeMonths: number | null;
  images: string[];
  variants: Array<{ productId: string; label: string; price: string; availability: string }>;
  offers: Array<{ id: string; name: string; kind: string; listingIds: string[]; areaOnly: boolean }>;
}
export function FastQueProductExtras({ offer }: { offer: CommerceProductDto }) {
  const [x, setX] = useState<Extras | null>(null);
  const [reviews, setReviews] = useState<CommerceReviewsDto | null>(null);
  const [together, setTogether] = useState<CommerceProductDto[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = offer.productId;
  useEffect(() => {
    let live = true;
    rememberViewed(offer.listingId);
    countPage("PRODUCT_VIEW");
    apiFetch<Extras>(`commerce/products/${id}/details`).then((r) => live && setX(r)).catch(() => undefined);
    apiFetch<CommerceReviewsDto>(`commerce/products/${id}/reviews`).then((r) => live && setReviews(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, offer.listingId]);
  const bundle = x?.offers.find((o) => o.kind === "BUNDLE");
  const others = bundle?.listingIds.filter((l) => l !== offer.listingId).join(",");
  useEffect(() => {
    if (!others) return;
    let live = true;
    apiFetch<CommerceProductDto[]>(`commerce/listings?ids=${others}`).then((r) => live && setTogether(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [others]);
  useEffect(() => {
    if (zoom) dialog.current?.showModal();
  }, [zoom]);
  const facts: Array<[string, string | null]> = x ? [["Benefits", x.benefits], ["How to use", x.usage], ["Ingredients", x.ingredients], ["Warnings", x.warnings], ["Country of origin", x.countryOfOrigin], ["Manufacturer", x.manufacturer], ["Shelf life", x.shelfLifeMonths ? `${x.shelfLifeMonths} months` : null]] : [];
  const shown = facts.filter((f) => f[1]);
  return (
    <>
      {x && x.offers.map((o) => <p key={o.id} className={c.good}>🏷 {o.name}{o.areaOnly ? " (selected areas; checked with your PIN)" : ""}</p>)}
      {bundle && together.length > 0 && (
        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => [offer, ...together].forEach((p) => fqBag.add(lineOf(p)))}>
          Add the set: {[offer, ...together].map((p) => p.name).join(" + ")}
        </button>
      )}
      {x && x.variants.length > 1 && (
        <nav className={s.chips} aria-label="Sizes and shades">
          {x.variants.map((v) => (
            <Link key={v.productId} href={`/shop/p/${v.productId}`} className={`${s.chip} ${v.productId === id ? s.chipOn : ""}`} aria-current={v.productId === id ? "page" : undefined}>
              {v.label} · {rupees(v.price)}{v.availability === "OUT_OF_STOCK" ? " (out of stock)" : ""}
            </Link>
          ))}
        </nav>
      )}
      {x && x.images.length > 0 && (
        <div className={c.gallery}>
          {x.images.map((u, i) => (
            <button key={u} type="button" className={c.shot} aria-label={`Enlarge photo ${i + 1}`} onClick={() => setZoom(u)}>
              {/* eslint-disable-next-line @next/next/no-img-element -- catalog images live on several hosts */}
              <img src={u} alt={`${offer.name}, photo ${i + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      <dialog ref={dialog} className={c.zoom} aria-label="Enlarged photo" onClose={() => setZoom(null)} onClick={() => dialog.current?.close()}>
        {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
        {zoom && <img src={zoom} alt={offer.name} />}
        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>Close</button>
      </dialog>
      {shown.length > 0 && (
        <details className={c.group} open>
          <summary><strong>Product details</strong></summary>
          {shown.map(([k, v]) => <p key={k} className={c.fact}><strong>{k}</strong><br />{v}</p>)}
        </details>
      )}
      {reviews && (
        <section className={c.group} aria-label="Reviews">
          <strong>Reviews</strong>
          {reviews.average != null ? <Stars average={reviews.average} count={reviews.count} /> : <span className={s.cardMeta}>No reviews yet. Customers can review after delivery.</span>}
          {reviews.items.map((r) => (
            <div key={r.id} className={c.fact}>
              <span className={c.stars} aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span> <strong>{r.displayName}</strong> <small>Verified purchase · {new Date(r.createdAt).toLocaleDateString("en-IN")}</small>
              {r.body && <p style={{ margin: "4px 0 0" }}>{r.body}</p>}
              {r.reply && <p className={s.cardMeta}>FastQue: {r.reply}</p>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

// ---------- Storefront ----------

export function Banners() {
  const [rows, setRows] = useState<CommerceBannerDto[]>([]);
  useEffect(() => {
    apiFetch<CommerceBannerDto[]>("commerce/banners").then(setRows).catch(() => undefined);
  }, []);
  if (!rows.length) return null;
  return (
    <section className={c.banners} aria-label="Announcements">
      {rows.map((b) => (
        <Link key={b.id} href={b.linkPath} className={c.banner}>
          {/* eslint-disable-next-line @next/next/no-img-element -- staff-entered https image */}
          {b.imageUrl && <img src={b.imageUrl} alt="" loading="lazy" />}
          <strong>{b.title}</strong>
          {b.subtitle && <span>{b.subtitle}</span>}
        </Link>
      ))}
    </section>
  );
}
/** Recently viewed on this device, and suggestions from the customer's own orders. */
export function PersonalRails() {
  const viewed = useFqViewed();
  const { user } = useAuth();
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const [recent, setRecent] = useState<CommerceProductDto[]>([]);
  const [forYou, setForYou] = useState<CommerceProductDto[]>([]);
  const ids = viewed.slice(0, 8).join(",");
  useEffect(() => {
    if (ids) apiFetch<CommerceProductDto[]>(`commerce/listings?ids=${ids}`).then(setRecent).catch(() => undefined);
  }, [ids]);
  useEffect(() => {
    if (isCustomer) apiFetch<CommerceProductDto[]>("customer/commerce/recommendations").then(setForYou).catch(() => undefined);
  }, [isCustomer]);
  const rail = (title: string, items: CommerceProductDto[]) =>
    items.length > 0 && (
      <section className={s.section} aria-label={title}>
        <h2 className={s.h2}>{title}</h2>
        <FastQueGrid items={items} />
      </section>
    );
  return (
    <>
      {rail("Because of what you bought", isCustomer ? forYou : [])}
      {rail("Recently viewed", ids ? recent : [])}
    </>
  );
}

/** Keeps a signed-in customer's FastQue bag on their account, merging it with this device's once. */
export function BagSync() {
  const cfg = useCommerceConfig();
  const { user } = useAuth();
  const lines = useFqBag();
  const userId = cfg.enabled && user?.roles.includes("CUSTOMER") ? user.id : null;
  const merged = useRef<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!userId || merged.current === userId) return;
    merged.current = userId;
    apiFetch<Array<{ product: CommerceProductDto; quantity: number }>>("customer/commerce/bag")
      .then((saved) => {
        fqBag.merge(saved.map((x) => lineOf(x.product, x.quantity)));
        setReady(userId);
      })
      .catch(() => undefined);
  }, [userId]);
  const key = JSON.stringify(lines.map((l) => ({ listingId: l.listingId, quantity: l.quantity })));
  useEffect(() => {
    if (!userId || ready !== userId) return;
    const t = setTimeout(() => void apiFetch("customer/commerce/bag", { method: "PUT", body: `{"items":${key}}` }).catch(() => undefined), 1500);
    return () => clearTimeout(t);
  }, [userId, ready, key]);
  return null;
}

// ---------- Order page ----------

type Call = { base: string; suffix: string; order: CommerceOrderDto };
export function OrderExtras({ base, suffix, order }: Call) {
  const [error, setError] = useState<string | null>(null);
  const bill = () =>
    apiFetch<InvoiceDto>(`${base}/invoice${suffix}`)
      .then((i) => printDocument(`Bill ${i.orderNumber}`, [invoicePage(i)]))
      .catch((e) => setError(errText(e, "The bill could not be loaded.")));
  return (
    <>
      {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
      <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => void bill()}>Print bill / save as PDF</button>
      {order.status === "DELIVERED" && order.items.map((i) => <ReviewForm key={i.id} item={i} base={base} suffix={suffix} name={order.contactName} />)}
      {order.returns.filter((r) => ["REQUESTED", "APPROVED"].includes(r.status)).map((r) => <ReturnPhotos key={r.id} number={r.number} path={`${base}/returns/${r.id}/photos${suffix}`} />)}
      <Support base={base} suffix={suffix} order={order} />
    </>
  );
}
function ReviewForm({ item, base, suffix, name }: { item: CommerceOrderDto["items"][number]; base: string; suffix: string; name: string }) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [as, setAs] = useState(name.split(" ")[0] ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (msg?.ok) return <p className={c.good} role="status">{item.name}: {msg.text}</p>;
  return (
    <details className={c.group}>
      <summary>Review {item.name}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apiFetch(`${base}/reviews${suffix}`, { method: "POST", body: JSON.stringify({ orderItemId: item.id, rating, body: body.trim() || null, displayName: as.trim() }) })
            .then(() => setMsg({ ok: true, text: "thank you. Your review appears after FastQue checks it." }))
            .catch((x) => setMsg({ ok: false, text: errText(x, "The review was not saved.") }));
        }}
      >
        <label className={s.field}>Rating<select className={s.select} value={rating} onChange={(e) => setRating(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} out of 5</option>)}</select></label>
        <label className={s.field}>Name shown<input className={s.input} required minLength={2} maxLength={60} value={as} onChange={(e) => setAs(e.target.value)} /></label>
        <label className={s.field}>Your review (optional)<textarea className={s.input} maxLength={1500} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {msg && <p className={c.bad} role="alert">{msg.text}</p>}
        <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`}>Send review</button>
      </form>
    </details>
  );
}
function ReturnPhotos({ number, path }: { number: string; path: string }) {
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(0);
  async function send(files: FileList | null) {
    for (const f of Array.from(files ?? []).slice(0, 5)) {
      const body = new FormData();
      body.append("file", f);
      try {
        await apiFetch(path, { method: "POST", body });
        setSent((n) => n + 1);
        setMsg("");
      } catch (e) {
        setMsg(errText(e, "The photo was not sent."));
        return;
      }
    }
  }
  return (
    <label className={s.field}>
      Photos for return {number} (up to 5, only FastQue staff see them)
      <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void send(e.target.files)} />
      <span role="status" className={msg ? c.bad : c.good}>{msg || (sent ? `${sent} photo(s) sent.` : "")}</span>
    </label>
  );
}
const CATEGORY: Record<string, string> = { DELIVERY: "Delivery", PRODUCT: "Product", RETURN_REFUND: "Return or refund", PAYMENT: "Payment", CANCELLATION: "Cancellation", INVOICE: "Bill", OTHER: "Something else" };
const STATUS: Record<string, string> = { OPEN: "Open", IN_PROGRESS: "Being looked at", WAITING_CUSTOMER: "Waiting for you", RESOLVED: "Resolved", CLOSED: "Closed" };
function Support({ base, suffix, order }: Call) {
  const [list, setList] = useState<CommerceTicketDto[]>([]);
  const [category, setCategory] = useState("DELIVERY");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<CommerceTicketDto[]>(`${base}/tickets${suffix}`).then(setList).catch(() => undefined);
  }, [base, suffix]);
  const post = (path: string, payload: unknown, after: () => void) =>
    apiFetch<CommerceTicketDto[]>(`${base}/${path}${suffix}`, { method: "POST", body: JSON.stringify(payload) })
      .then((r) => {
        setList(r);
        setError(null);
        after();
      })
      .catch((e) => setError(errText(e, "That was not sent. Try again.")));
  return (
    <section className={c.group} aria-label="Help with this order">
      <strong>Help with this order</strong>
      {error && <p className={c.bad} role="alert">{error}</p>}
      {list.map((t) => (
        <details key={t.id} open={t.status === "WAITING_CUSTOMER"}>
          <summary>{t.subject} · {STATUS[t.status] ?? t.status} <small>({t.number})</small></summary>
          {t.messages.map((m) => <p key={m.id} className={c.fact}><strong>{m.from === "STAFF" ? "FastQue" : "You"}</strong> <small>{new Date(m.createdAt).toLocaleString("en-IN")}</small><br />{m.body}</p>)}
          {t.status !== "CLOSED" && (
            <form className={s.row} onSubmit={(e) => { e.preventDefault(); void post(`tickets/${t.id}`, { body: (reply[t.id] ?? "").trim() }, () => setReply({ ...reply, [t.id]: "" })); }}>
              <input className={s.input} aria-label={`Reply to ${t.subject}`} required maxLength={3000} value={reply[t.id] ?? ""} onChange={(e) => setReply({ ...reply, [t.id]: e.target.value })} />
              <button type="submit" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>Reply</button>
            </form>
          )}
        </details>
      ))}
      <details>
        <summary>Ask a question</summary>
        <form onSubmit={(e) => { e.preventDefault(); void post("tickets", { category, subject: subject.trim(), body: body.trim() }, () => { setSubject(""); setBody(""); }); }}>
          <label className={s.field}>About<select className={s.select} value={category} onChange={(e) => setCategory(e.target.value)}>{COMMERCE_TICKET_CATEGORIES.map((x) => <option key={x} value={x}>{CATEGORY[x]}</option>)}</select></label>
          <label className={s.field}>Subject<input className={s.input} required minLength={3} maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className={s.field}>Message<textarea className={s.input} required minLength={3} maxLength={3000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          <button type="submit" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`}>Send about {order.orderNumber}</button>
        </form>
      </details>
    </section>
  );
}

// ---------- Saved addresses ----------

type Saved = CommerceAddressInput & { id: string };
const EMPTY = { label: "", name: "", phone: "", line1: "", line2: "", landmark: "", city: "", state: "", pincode: "" };
type Draft = typeof EMPTY;
export function SavedAddresses() {
  const cfg = useCommerceConfig();
  const { user } = useAuth();
  const on = cfg.enabled && !!user?.roles.includes("CUSTOMER");
  const [rows, setRows] = useState<Saved[]>([]);
  const [edit, setEdit] = useState<{ id: string | null; v: Draft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => apiFetch<Saved[]>("customer/commerce/addresses").then(setRows).catch(() => undefined);
  useEffect(() => {
    if (on) apiFetch<Saved[]>("customer/commerce/addresses").then(setRows).catch(() => undefined);
  }, [on]);
  if (!on) return null;
  const body = (a: Draft, isDefault?: boolean) => JSON.stringify({ ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, a[k as keyof Draft] || (["label", "line2", "landmark"].includes(k) ? null : "")])), ...(isDefault ? { isDefault } : {}) });
  const run = (p: Promise<unknown>, after?: () => void) =>
    p
      .then(() => {
        setError(null);
        after?.();
        void load();
      })
      .catch((e) => setError(errText(e, "The address was not saved.")));
  const draft = (a: Saved): Draft => Object.fromEntries(Object.keys(EMPTY).map((k) => [k, (a[k as keyof Draft] as string | null) ?? ""])) as Draft;
  const LABELS: Draft = { label: "Label (Home, Work…)", name: "Full name", phone: "Mobile", line1: "House / flat and street", line2: "Area", landmark: "Landmark", city: "City", state: "State", pincode: "PIN code" };
  return (
    <section aria-label="Saved addresses" className={c.box}>
      <h2 style={{ marginTop: 0 }}>Delivery addresses</h2>
      {error && <p role="alert">{error}</p>}
      {rows.length === 0 && !edit && <p>No saved addresses yet.</p>}
      {rows.map((a) => (
        <div key={a.id} className={c.boxRow}>
          <span><strong>{a.label || a.name}</strong>{a.isDefault ? " · default" : ""}<br /><small>{[a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(", ")} · {a.phone}</small></span>
          <span className={c.boxActions}>
            {!a.isDefault && <button type="button" onClick={() => void run(apiFetch(`customer/commerce/addresses/${a.id}`, { method: "PUT", body: body(draft(a), true) }))}>Make default</button>}
            <button type="button" onClick={() => setEdit({ id: a.id, v: draft(a) })}>Edit</button>
            <button type="button" onClick={() => window.confirm("Remove this address?") && void run(apiFetch(`customer/commerce/addresses/${a.id}`, { method: "DELETE" }))}>Remove</button>
          </span>
        </div>
      ))}
      {edit ? (
        <form className={c.formGrid} onSubmit={(e) => { e.preventDefault(); void run(apiFetch(`customer/commerce/addresses${edit.id ? `/${edit.id}` : ""}`, { method: edit.id ? "PUT" : "POST", body: body(edit.v) }), () => setEdit(null)); }}>
          {(Object.keys(EMPTY) as Array<keyof Draft>).map((k) => (
            <label key={k} style={{ display: "grid", gap: 4 }}>{LABELS[k]}<input required={!["label", "line2", "landmark"].includes(k)} value={edit.v[k]} inputMode={k === "pincode" ? "numeric" : k === "phone" ? "tel" : undefined} onChange={(e) => setEdit({ ...edit, v: { ...edit.v, [k]: e.target.value } })} /></label>
          ))}
          <span className={c.boxActions}><button type="submit">Save</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></span>
        </form>
      ) : (
        <button type="button" onClick={() => setEdit({ id: null, v: EMPTY })}>Add address</button>
      )}
    </section>
  );
}
