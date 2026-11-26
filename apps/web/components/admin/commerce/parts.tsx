"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiFetch, ApiError } from "../../../lib/api";
import { newIdempotencyKey } from "../../../lib/idempotency";
import ui from "../../owner/owner.module.css";
import css from "../inventory/admin-inventory.module.css";
import c from "./admin-commerce.module.css";

// Small building blocks shared by every FastQue Commerce admin tab.

export const API = "admin/commerce";
export type Row = Record<string, unknown> & { id: string };
export type Page = { items: Row[]; total: number; page: number; pageSize: number };
export const inr = (v: unknown) => (v == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(v))}`);
export const day = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" }) : "—");
export const err = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");
export const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);
export const str = (o: unknown, path: string) => {
  const v = get(o, path);
  return v == null ? "" : String(v);
};

export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!path) return;
    apiFetch<T>(`${API}/${path}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(err(e)));
  }, [path]);
  useEffect(() => load(), [load]);
  return { data, error, load };
}
export async function send(path: string, body: unknown, method: "POST" | "PUT" = "POST", keyed = false) {
  return apiFetch(`${API}/${path}`, { method, headers: keyed ? { "Idempotency-Key": newIdempotencyKey() } : {}, body: JSON.stringify(body) });
}

// ---------- Small building blocks ----------

export interface Field {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "checkbox" | "select" | "list" | "multi" | "area" | "datetime";
  options?: ReadonlyArray<readonly [string, string]>;
  optional?: boolean;
  hint?: string;
}
/** An ISO time as the local value a datetime-local input needs. */
const localTime = (x: unknown) => {
  const s = String(x ?? "");
  if (!s.endsWith("Z")) return s;
  const d = new Date(s);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
/** One form renderer for every admin form; empty optional fields are sent as null. */
export function Form({ fields, initial, submit, label, onDone }: { fields: Field[]; initial?: Record<string, unknown>; submit: (v: Record<string, unknown>) => Promise<unknown>; label: string; onDone: () => void }) {
  const [v, setV] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.key, initial?.[f.key] ?? (f.type === "checkbox" ? false : f.type === "select" ? (f.options?.[0]?.[0] ?? "") : "")])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const x = v[f.key];
        if (f.type === "checkbox") body[f.key] = !!x;
        else if (f.type === "multi") body[f.key] = Array.isArray(x) ? x : [];
        else if (f.type === "list") body[f.key] = String(x ?? "").split(/[\s,]+/).filter(Boolean);
        else if (x === "" || x == null) {
          if (f.optional) body[f.key] = null;
        } else if (f.type === "number") body[f.key] = Number(x);
        else if (f.type === "datetime") body[f.key] = new Date(String(x)).toISOString();
        else body[f.key] = String(x);
      }
      await submit(body);
      onDone();
    } catch (ex) {
      setError(err(ex));
      setBusy(false);
    }
  }
  return (
    <form className={c.form} onSubmit={(e) => void go(e)}>
      {fields.map((f) => (
        <label key={f.key} className={f.type === "checkbox" ? c.check : c.field}>
          {f.type === "checkbox" ? (
            <>
              <input type="checkbox" checked={!!v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.checked })} /> {f.label}
            </>
          ) : (
            <>
              {f.label}
              {f.type === "select" ? (
                <select value={String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                  {f.options?.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              ) : f.type === "multi" ? (
                <select multiple size={5} value={Array.isArray(v[f.key]) ? (v[f.key] as string[]) : []} onChange={(e) => setV({ ...v, [f.key]: Array.from(e.target.selectedOptions, (o) => o.value) })}>
                  {f.options?.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              ) : f.type === "area" ? (
                <textarea rows={3} required={!f.optional} value={String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              ) : f.type === "datetime" ? (
                <input type="datetime-local" required={!f.optional} value={localTime(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              ) : (
                <input type={f.type === "number" || f.type === "date" ? f.type : "text"} step="any" required={!f.optional && f.type !== "list"} value={Array.isArray(v[f.key]) ? (v[f.key] as string[]).join(", ") : String(v[f.key] ?? "")} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              )}
              {f.hint && <small>{f.hint}</small>}
            </>
          )}
        </label>
      ))}
      {error && <p className={c.error} role="alert">{error}</p>}
      <div className={ui.rowWrap}>
        <button type="submit" className={css.verify} disabled={busy}>{busy ? "Saving…" : label}</button>
        <button type="button" className={css.tab} onClick={onDone}>Close</button>
      </div>
    </form>
  );
}

export function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className={ui.hint}>{empty}</p>;
  return (
    <div className={c.tableWrap}>
      <table className={c.table}>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{x}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={ui.card} aria-label={title}>
      <div className={ui.cardHead}><h2 className={ui.cardTitle}>{title}</h2>{action}</div>
      {children}
    </section>
  );
}
export function Stats({ items }: { items: Array<[string, ReactNode]> }) {
  return <div className={css.summaryGrid}>{items.map(([l, v]) => <div key={l} className={css.stat}><span className={css.statValue}>{v}</span><span className={css.statLabel}>{l}</span></div>)}</div>;
}
export function Busy({ error }: { error: string | null }) {
  return error ? <p className={c.error} role="alert">{error}</p> : <div className={`${ui.skeleton} ${css.skeletonSmall}`} />;
}
/** A paged list with search and an optional status filter. */
export function List({ title, path, statuses, head, row, empty, action, reloadKey }: { title: string; path: string; statuses?: ReadonlyArray<readonly [string, string]>; head: string[]; row: (r: Row, reload: () => void) => ReactNode[]; empty: string; action?: ReactNode; reloadKey?: number }) {
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState(statuses?.[0]?.[0] ?? "");
  const [page, setPage] = useState(1);
  const { data, error, load } = useLoad<Page>(`${path}?page=${page}&limit=25${q ? `&q=${encodeURIComponent(q)}` : ""}${status ? `&status=${status}` : ""}`);
  useEffect(() => {
    if (reloadKey) load();
  }, [reloadKey, load]);
  const pages = data ? Math.ceil(data.total / data.pageSize) : 0;
  return (
    <Card title={title} action={action}>
      <form className={ui.rowWrap} onSubmit={(e) => { e.preventDefault(); setPage(1); setQ(typed.trim()); }}>
        <input className={c.input} aria-label={`Search ${title}`} placeholder="Search" value={typed} onChange={(e) => setTyped(e.target.value)} />
        {statuses && <select className={c.input} aria-label="Status" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>{statuses.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        <button type="submit" className={css.tab}>Search</button>
      </form>
      {!data ? <Busy error={error} /> : <Table head={head} rows={data.items.map((r) => row(r, load))} empty={empty} />}
      {pages > 1 && (
        <div className={ui.rowWrap}>
          <button type="button" className={css.tab} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className={ui.hint}>Page {page} of {pages}</span>
          <button type="button" className={css.tab} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </Card>
  );
}
export const ALL = ["", "All"] as const;


export function useOptions(path: string, label: (r: Row) => string) {
  const [o, setO] = useState<Array<readonly [string, string]>>([]);
  useEffect(() => {
    apiFetch<Row[] | Page>(`${API}/${path}`)
      .then((d) => setO((Array.isArray(d) ? d : d.items).map((r) => [r.id, label(r)] as const)))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- label is a pure formatter
  }, [path]);
  return o;
}
export const productLabel = (r: Row) => `${str(r, "globalProduct.name")} · ${str(r, "sku")}`;

/** A plain list whose rows open one form (warehouses, zones, coupons, suppliers). */
export function Crud({ title, path, fields, head, row, empty, canEdit, initial, extra }: { title: string; path: string; fields: Field[]; head: string[]; row: (r: Row) => ReactNode[]; empty: string; canEdit: boolean; initial?: Record<string, unknown>; extra?: (r: Row, reload: () => void) => ReactNode }) {
  const { data, error, load } = useLoad<Row[]>(path);
  const [edit, setEdit] = useState<Row | "new" | null>(null);
  const done = () => {
    setEdit(null);
    load();
  };
  return (
    <>
      {edit && (
        <Card title={edit === "new" ? `New: ${title}` : "Edit"}>
          <Form key={edit === "new" ? "new" : edit.id} fields={fields} initial={edit === "new" ? initial : edit} submit={(v) => send(edit === "new" ? path : `${path}/${edit.id}`, v, edit === "new" ? "POST" : "PUT")} label="Save" onDone={done} />
        </Card>
      )}
      <Card title={title} action={canEdit ? <button type="button" className={css.verify} onClick={() => setEdit("new")}>Add</button> : null}>
        {!data ? <Busy error={error} /> : (
          <Table head={[...head, ""]} empty={empty} rows={data.map((r) => [...row(r), <span key="x" className={ui.rowWrap}>{canEdit && <button type="button" className={css.tab} onClick={() => setEdit(r)}>Edit</button>}{extra?.(r, load)}</span>])} />
        )}
      </Card>
    </>
  );
}
