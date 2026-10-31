"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ADMIN_PATHS, CATALOG_PATHS, type AdminInventoryOverviewDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import ui from "../../owner/owner.module.css";
import { useAdminFilters } from "../shell/admin-filters";
import { formatRangeLabel } from "../shop-activity-range";
import css from "./admin-inventory.module.css";

const inr = (value: string) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Number(value))}`;
const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "—");

/**
 * Admin inventory overview (Inventory Phase 1): platform-wide stock KPIs and a shop-wise table,
 * filtered by the admin date range and, optionally, one shop (?salonId=). Stock value is at each
 * shop's weighted average purchase cost; nothing here is estimated or invented.
 */
export function AdminInventoryOverview() {
  const { range } = useAdminFilters();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const salonId = params.get("salonId") ?? "";
  const [data, setData] = useState<AdminInventoryOverviewDto | null>(null);
  const [allShops, setAllShops] = useState<AdminInventoryOverviewDto["shops"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    const base = `${ADMIN_PATHS.admin}/${CATALOG_PATHS.adminInventoryOverview}`;
    const query = (extra: Record<string, string>) => new URLSearchParams({ from: range.from, to: range.to, ...extra }).toString();
    void Promise.resolve().then(async () => {
      try {
        const overall = await apiFetch<AdminInventoryOverviewDto>(`${base}?${query({})}`);
        const filtered = salonId ? await apiFetch<AdminInventoryOverviewDto>(`${base}?${query({ salonId })}`) : overall;
        if (cancelled) return;
        setAllShops(overall.shops);
        setData(filtered);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load inventory figures.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, salonId]);

  const chooseShop = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("salonId", id);
    else next.delete("salonId");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`);
  };

  const shops = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.shops ?? []).filter((s) => !term || s.name.toLowerCase().includes(term) || (s.city ?? "").toLowerCase().includes(term));
  }, [data, q]);
  const k = data?.kpis;
  const selected = allShops.find((s) => s.salonId === salonId);

  return (
    <main className={ui.grid} aria-labelledby="inv-title">
      <div className={ui.pageHead}>
        <div>
          <div className={ui.eyebrow}>Inventory</div>
          <h1 id="inv-title" className={ui.pageTitle}>Inventory overview</h1>
          <p className={ui.pageSub}>
            {formatRangeLabel(range.from, range.to)} · {selected ? selected.name : "all shops"}. Stock value is at each shop&apos;s average purchase cost; entries are counted from each shop&apos;s stock history.
          </p>
        </div>
        <label className={css.shopFilter}>
          <span className={ui.label}>Shop</span>
          <select className={ui.input} value={salonId} onChange={(e) => chooseShop(e.target.value)} aria-label="Filter by shop">
            <option value="">All shops</option>
            {allShops.map((s) => <option key={s.salonId} value={s.salonId}>{s.name}{s.city ? ` · ${s.city}` : ""}</option>)}
          </select>
        </label>
      </div>

      {error && <p className={`${ui.banner} ${ui.bannerError}`} role="alert">{error}</p>}
      {!data && !error && <div className={`${ui.skeleton} ${css.skeleton}`} role="status" aria-label="Loading inventory figures" />}

      {data && k && (
        <>
          <section className={css.kpis} aria-label="Inventory figures">
            {[
              ["Shops using inventory", k.shopsUsingInventory, "with at least one product"],
              ["Products tracked", k.productsTracked, "active, across shelves"],
              ["Stock value", inr(k.stockValue), "at average purchase cost"],
              ["Low stock", k.lowStockItems, "at or below reorder level"],
              ["Out of stock", k.outOfStockItems, "nothing left"],
              ["Stock bought", inr(k.purchasesValue), `${k.purchaseEntries} entries this period`],
              ["Stock used", k.consumptionEntries, "entries this period"],
              ["Write-offs", k.lossEntries, "returned, damaged, expired, wasted"],
              ["Catalog: verified", k.catalogVerified, "products in the FastQue catalog"],
              ["Catalog: to review", k.catalogPending, "submitted by salons"],
            ].map(([label, value, foot]) => (
              <div key={String(label)} className={`${ui.card} ${ui.cardTight} ${ui.kpi}`}>
                <div className={ui.kpiTop}>{label}</div>
                <div className={ui.kpiValue}>{value}</div>
                <div className={ui.kpiFoot}>{foot}</div>
              </div>
            ))}
          </section>

          {k.catalogPending > 0 && (
            <p className={`${ui.banner} ${ui.bannerInfo}`}>
              {k.catalogPending} catalog product{k.catalogPending === 1 ? " is" : "s are"} waiting for review.{" "}
              <Link className={ui.cardLink} href="/dashboard/admin/inventory/catalog?status=PENDING">Review them</Link>
            </p>
          )}

          <section className={ui.card} aria-labelledby="inv-shops">
            <div className={ui.cardHead}>
              <div>
                <h2 id="inv-shops" className={ui.cardTitle}>Shop-wise inventory</h2>
                <p className={ui.cardSub}>{shops.length} shop{shops.length === 1 ? "" : "s"}{salonId ? "" : " using inventory"}</p>
              </div>
              {!salonId && (
                <input className={`${ui.input} ${css.search}`} placeholder="Search shop or city" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search shops" />
              )}
            </div>
            {shops.length === 0 ? (
              <p className={ui.hint}>No shop has started using inventory{salonId ? "" : " yet"}.</p>
            ) : (
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th>Shop</th>
                      <th className={ui.num}>Products</th>
                      <th className={ui.num}>Stock value</th>
                      <th className={ui.num}>Low</th>
                      <th className={ui.num}>Out</th>
                      <th className={ui.num}>Entries</th>
                      <th>Last stock change</th>
                      <th><span className={css.srOnly}>Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shops.map((s) => (
                      <tr key={s.salonId}>
                        <td><strong>{s.name}</strong>{s.city && <div className={ui.cardSub}>{s.city}</div>}</td>
                        <td className={ui.num}>{s.productsTracked}</td>
                        <td className={ui.num}>{inr(s.stockValue)}</td>
                        <td className={ui.num}>{s.lowStockItems || "—"}</td>
                        <td className={ui.num}>{s.outOfStockItems || "—"}</td>
                        <td className={ui.num}>{s.movementsInRange}</td>
                        <td>{when(s.lastStockUpdate)}</td>
                        <td className={css.actions}>
                          {!salonId && <button type="button" className={ui.cardLink} onClick={() => chooseShop(s.salonId)}>Filter</button>}
                          <Link className={ui.cardLink} href={`/dashboard/salons/${s.salonId}/inventory`}>Open inventory</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.topProducts.length > 0 && (
            <section className={ui.card} aria-labelledby="inv-top">
              <h2 id="inv-top" className={ui.cardTitle}>Most stocked catalog products</h2>
              <ol className={css.top}>
                {data.topProducts.map((p) => (
                  <li key={p.globalProductId}>
                    <span>{p.name}{p.brand ? <small> · {p.brand}</small> : null}</span>
                    <strong>{p.salons} shop{p.salons === 1 ? "" : "s"}</strong>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  );
}
