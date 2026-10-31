"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ADMIN_PATHS,
  CATALOG_IMPORT_COLUMNS,
  CATALOG_PATHS,
  Role,
  type AdminCatalogProductDto,
  type CatalogImportRowResult,
  type InventoryPageDto,
  type ProductVerificationStatus,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { useAuth } from "../../../lib/auth-context";
import ui from "../../owner/owner.module.css";
import css from "./admin-inventory.module.css";

const BASE = `${ADMIN_PATHS.admin}/${CATALOG_PATHS.adminCatalog}`;
const STATUS_TABS: Array<{ value: ProductVerificationStatus | ""; label: string }> = [
  { value: "PENDING", label: "To review" },
  { value: "VERIFIED", label: "Verified" },
  { value: "REJECTED", label: "Rejected" },
  { value: "", label: "All" },
];
const SOURCE_LABEL: Record<string, string> = {
  ADMIN: "Added by FastQue",
  CSV_IMPORT: "Imported",
  OPEN_BEAUTY_FACTS: "Open Beauty Facts",
  SALON_SUBMITTED: "Added by a salon",
};
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);

/**
 * Admin: the FastQue Global Product Master (Inventory Phase 1). Review products salons added
 * (verify or reject with a reason), see possible duplicates, and bulk-import verified products from
 * a CSV with a row-by-row preview. Viewers can browse; only platform admins and co-founders change it.
 */
export function AdminProductCatalog() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const canManage = !!user?.roles.some((r) => r === Role.PLATFORM_ADMIN || r === Role.CO_FOUNDER);
  const view = params.get("view") === "import" && canManage ? "import" : "list";
  const status = (params.get("status") ?? "PENDING") as ProductVerificationStatus | "";

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`);
  };

  return (
    <main className={ui.grid} aria-labelledby="catalog-title">
      <div className={ui.pageHead}>
        <div>
          <div className={ui.eyebrow}>Inventory</div>
          <h1 id="catalog-title" className={ui.pageTitle}>Product catalog</h1>
          <p className={ui.pageSub}>
            The shared FastQue product list, identified by barcode. Salons keep their own stock and prices; a product a salon adds stays with that salon until it is verified here.
          </p>
        </div>
        {canManage && (
          <div className={ui.rowWrap}>
            <button type="button" className={`${css.tab} ${view === "list" ? css.tabOn : ""}`} onClick={() => setParam("view", null)}>Products</button>
            <button type="button" className={`${css.tab} ${view === "import" ? css.tabOn : ""}`} onClick={() => setParam("view", "import")}>Import CSV</button>
          </div>
        )}
      </div>
      {view === "import" ? <CatalogImport /> : <CatalogList status={status} onStatus={(s) => setParam("status", s)} canManage={canManage} />}
    </main>
  );
}

function CatalogList({ status, onStatus, canManage }: { status: ProductVerificationStatus | ""; onStatus: (s: string) => void; canManage: boolean }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<AdminCatalogProductDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      const query = new URLSearchParams({ limit: "25", ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(after ? { cursor: after } : {}) });
      try {
        const page = await apiFetch<InventoryPageDto<AdminCatalogProductDto>>(`${BASE}?${query}`);
        setItems((prev) => (after && prev ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        setError(errorText(err, "Could not load the catalog."));
      }
    },
    [status, q],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(null), 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function review(product: AdminCatalogProductDto, action: "VERIFY" | "REJECT") {
    let note: string | undefined;
    if (action === "REJECT") {
      const reason = window.prompt(`Why is "${product.name}" being rejected? (The salon keeps its own stock.)`);
      if (!reason?.trim()) return;
      note = reason.trim();
    }
    try {
      await apiFetch(`${BASE}/${product.id}`, { method: "PATCH", body: JSON.stringify({ action, ...(note ? { note } : {}) }) });
      setNotice(action === "VERIFY" ? `"${product.name}" is verified and now visible to every salon.` : `"${product.name}" was rejected.`);
      void load(null);
    } catch (err) {
      setError(errorText(err, "That did not go through."));
    }
  }

  return (
    <section className={ui.card} aria-label="Catalog products">
      <div className={ui.cardHead}>
        <div className={ui.rowWrap} role="tablist" aria-label="Review status">
          {STATUS_TABS.map((tab) => (
            <button key={tab.label} type="button" role="tab" aria-selected={status === tab.value} className={`${css.tab} ${status === tab.value ? css.tabOn : ""}`} onClick={() => onStatus(tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        <input className={`${ui.input} ${css.search}`} placeholder="Search name, brand or barcode" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catalog" />
      </div>
      {error && <p className={`${ui.banner} ${ui.bannerError}`} role="alert">{error}</p>}
      <div role="status" aria-live="polite">{notice && <p className={`${ui.banner} ${ui.bannerOk}`}>{notice}</p>}</div>
      {!items ? (
        <div className={`${ui.skeleton} ${css.skeletonSmall}`} />
      ) : items.length === 0 ? (
        <p className={ui.hint}>{status === "PENDING" ? "Nothing to review right now." : "No products here yet."}</p>
      ) : (
        <ul className={css.products}>
          {items.map((p) => (
            <li key={p.id} className={css.productRow}>
              <div className={css.thumb}>
                {p.imageUrls[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- catalog photos are arbitrary URLs
                  <img src={p.imageUrls[0]} alt="" />
                ) : (
                  <span aria-hidden="true">📦</span>
                )}
              </div>
              <div className={css.productInfo}>
                <strong>{p.name}</strong>
                <span className={ui.cardSub}>
                  {[p.brand, p.category, p.packSize && p.packUnit ? `${Number(p.packSize)} ${p.packUnit.toLowerCase()}` : null, p.mrp ? `MRP ₹${Number(p.mrp)}` : null].filter(Boolean).join(" · ")}
                </span>
                <span className={ui.cardSub}>
                  Barcode {p.barcodes.map((b) => b.display).join(", ")} · {SOURCE_LABEL[p.dataSource] ?? p.dataSource}
                  {p.submittedBySalon ? ` (${p.submittedBySalon.name})` : ""}
                  {p.sourceLicense ? ` · licence ${p.sourceLicense}` : ""} · stocked by {p.salonsStocking} shop{p.salonsStocking === 1 ? "" : "s"}
                </span>
                {p.reviewNote && <span className={ui.cardSub}>Note: {p.reviewNote}</span>}
                {p.possibleDuplicates.length > 0 && (
                  <span className={css.dupe}>Possible duplicate of: {p.possibleDuplicates.map((d) => d.name).join(", ")}</span>
                )}
              </div>
              <div className={css.rowActions}>
                <span className={`${css.status} ${css[`status${p.verificationStatus}`]}`}>{p.verificationStatus === "PENDING" ? "To review" : p.verificationStatus === "VERIFIED" ? "Verified" : "Rejected"}</span>
                {canManage && p.verificationStatus !== "VERIFIED" && <button type="button" className={css.verify} onClick={() => void review(p, "VERIFY")}>Verify</button>}
                {canManage && p.verificationStatus !== "REJECTED" && <button type="button" className={ui.cardLink} onClick={() => void review(p, "REJECT")}>Reject</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor && <button type="button" className={`${css.tab} ${css.more}`} onClick={() => void load(cursor)}>Load more</button>}
    </section>
  );
}

type Preview = { rows: CatalogImportRowResult[]; headerErrors: string[]; summary: Record<CatalogImportRowResult["status"], number> };
const ROW_STATUS: Record<CatalogImportRowResult["status"], string> = {
  NEW: "Will be added",
  EXISTS: "Already in catalog",
  DUPLICATE_IN_FILE: "Repeated in file",
  INVALID: "Has errors",
};

function CatalogImport() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceReference, setSourceReference] = useState("");
  const [sourceLicense, setSourceLicense] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const form = (extra: Record<string, string> = {}) => {
    const body = new FormData();
    if (file) body.append("file", file);
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    return body;
  };

  async function runPreview() {
    if (!file) return setError("Choose a CSV file.");
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await apiFetch<Preview>(`${BASE}/${CATALOG_PATHS.adminImportPreview}`, { method: "POST", body: form() }));
    } catch (err) {
      setError(errorText(err, "The file could not be checked."));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!sourceReference.trim() || !sourceLicense.trim()) return setError("Say where the data came from and under what licence.");
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch<{ created: number; skipped: number }>(`${BASE}/${CATALOG_PATHS.adminImportCommit}`, {
        method: "POST",
        body: form({ sourceReference: sourceReference.trim(), sourceLicense: sourceLicense.trim() }),
      });
      setResult(`Added ${r.created} product${r.created === 1 ? "" : "s"} to the catalog as verified. ${r.skipped} row${r.skipped === 1 ? " was" : "s were"} skipped.`);
      setPreview(null);
    } catch (err) {
      setError(errorText(err, "Nothing was imported."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={ui.card} aria-label="Import catalog CSV">
      <h2 className={ui.cardTitle}>Import products from a CSV</h2>
      <p className={ui.cardSub}>
        Columns (first row): {CATALOG_IMPORT_COLUMNS.join(", ")}. Only <code>barcode</code> and <code>name</code> are required. Up to 5,000 rows / 2 MB. Imported products are marked verified, so only import data you are allowed to reuse.
      </p>
      <div className={`${ui.rowWrap} ${css.importForm}`}>
        <label className={css.field}>
          <span className={ui.label}>CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setResult(null); }} />
        </label>
        <label className={css.field}>
          <span className={ui.label}>Where the data came from</span>
          <input className={ui.input} maxLength={300} value={sourceReference} onChange={(e) => setSourceReference(e.target.value)} placeholder="e.g. Distributor price list, Oct 2026" />
        </label>
        <label className={css.field}>
          <span className={ui.label}>Licence / permission</span>
          <input className={ui.input} maxLength={80} value={sourceLicense} onChange={(e) => setSourceLicense(e.target.value)} placeholder="e.g. Supplied by distributor" />
        </label>
      </div>
      <div className={`${ui.rowWrap} ${css.mt}`}>
        <button type="button" className={css.tab} onClick={() => void runPreview()} disabled={busy || !file}>{busy && !preview ? "Checking…" : "Check file"}</button>
        {preview && preview.headerErrors.length === 0 && preview.summary.NEW > 0 && (
          <button type="button" className={css.verify} onClick={() => void commit()} disabled={busy}>{busy ? "Importing…" : `Import ${preview.summary.NEW} product${preview.summary.NEW === 1 ? "" : "s"}`}</button>
        )}
      </div>
      {error && <p className={`${ui.banner} ${ui.bannerError}`} role="alert">{error}</p>}
      <div role="status" aria-live="polite">{result && <p className={`${ui.banner} ${ui.bannerOk}`}>{result}</p>}</div>
      {preview && (
        <div className={css.mt}>
          {preview.headerErrors.length > 0 ? (
            <p className={`${ui.banner} ${ui.bannerError}`}>{preview.headerErrors.join(" ")}</p>
          ) : (
            <>
              <p className={ui.hint}>
                {preview.summary.NEW} to add · {preview.summary.EXISTS} already in the catalog · {preview.summary.DUPLICATE_IN_FILE} repeated · {preview.summary.INVALID} with errors
              </p>
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead><tr><th>Line</th><th>Barcode</th><th>Name</th><th>Result</th></tr></thead>
                  <tbody>
                    {preview.rows.slice(0, 200).map((row) => (
                      <tr key={row.line}>
                        <td className={ui.num}>{row.line}</td>
                        <td>{row.barcode}</td>
                        <td>{row.name}</td>
                        <td>
                          {ROW_STATUS[row.status]}
                          {row.errors.length > 0 && <div className={css.rowErrors}>{row.errors.join(" ")}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.rows.length > 200 && <p className={ui.hint}>Showing the first 200 of {preview.rows.length} rows.</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
