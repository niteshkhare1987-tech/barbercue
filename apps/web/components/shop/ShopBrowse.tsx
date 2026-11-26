"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ShopFacetsDto, ShopProductPageDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { locationQuery, useShopLocation } from "../../lib/shop/store";
import { CardGrid } from "./ShopParts";
import { FastQueRail } from "../commerce/CommerceParts";
import s from "./shop.module.css";

const SORTS = [
  ["relevance", "Relevance"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["nearest", "Nearest first"],
  ["popular", "Most popular"],
  ["newest", "New arrivals"],
] as const;
const PASS = ["q", "category", "brand", "minPrice", "maxPrice", "availableOnly", "onSale", "sort", "page", "radiusKm", "salonId"] as const;

/** Search + filters + sort. Everything lives in the URL so results are shareable and back/forward works. */
export function ShopBrowse() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const loc = useShopLocation();
  const [facets, setFacets] = useState<ShopFacetsDto | null>(null);
  const [result, setResult] = useState<{ key: string; page: ShopProductPageDto } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minPrice, setMinPrice] = useState(params.get("minPrice") ?? "");
  const [maxPrice, setMaxPrice] = useState(params.get("maxPrice") ?? "");

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in changes)) next.delete("page");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  useEffect(() => {
    apiFetch<ShopFacetsDto>("shop/facets").then(setFacets).catch(() => undefined);
  }, []);

  const query = new URLSearchParams();
  for (const k of PASS) {
    const v = params.get(k);
    if (v) query.set(k, v);
  }
  query.set("limit", "24");
  const lq = locationQuery(loc);
  const requestKey = `shop/products?${query}${lq ? `&${lq}` : ""}`;
  useEffect(() => {
    apiFetch<ShopProductPageDto>(requestKey)
      .then((page) => {
        setResult({ key: requestKey, page });
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Products could not load."));
  }, [requestKey]);
  const data = result?.page ?? null;
  const loading = result?.key !== requestKey && !error;

  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const page = Number(params.get("page") ?? "1");
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const catLabel = facets?.categories.find((c) => c.slug === category)?.label ?? (category === "offers" ? "Offers & Combos" : null);
  const title = q ? `Results for “${q}”` : catLabel ?? "Shop all";

  return (
    <main aria-labelledby="browse-title" style={{ paddingTop: 20 }}>
      <div className={s.eyebrow}>Marketplace</div>
      <h1 id="browse-title" className={s.h2}>{title}</h1>
      <div className={s.chips} style={{ marginTop: 12 }} aria-label="Categories">
        <button type="button" className={`${s.chip} ${!category ? s.chipOn : ""}`} onClick={() => set({ category: null })}>✨ All</button>
        {(facets?.categories ?? []).map((c) => (
          <button key={c.slug} type="button" className={`${s.chip} ${category === c.slug ? s.chipOn : ""}`} onClick={() => set({ category: c.slug })}>{c.label}</button>
        ))}
        <button type="button" className={`${s.chip} ${category === "offers" ? s.chipOn : ""}`} onClick={() => set({ category: "offers" })}>🎁 Offers</button>
      </div>

      <div className={s.browse}>
        <aside className={s.filters} aria-label="Filters">
          <div>
            <h3>Availability</h3>
            <label className={s.check}>
              <input type="checkbox" checked={params.get("availableOnly") === "true"} onChange={(e) => set({ availableOnly: e.target.checked ? "true" : null })} /> In stock at a salon
            </label>
            <label className={s.check} style={{ marginTop: 6 }}>
              <input type="checkbox" checked={params.get("onSale") === "true"} onChange={(e) => set({ onSale: e.target.checked ? "true" : null })} /> On offer
            </label>
          </div>
          <div>
            <h3>Price (₹)</h3>
            <form
              className={s.row}
              onSubmit={(e) => {
                e.preventDefault();
                set({ minPrice: minPrice.trim() || null, maxPrice: maxPrice.trim() || null });
              }}
            >
              <input className={s.input} style={{ width: 80 }} inputMode="numeric" placeholder="Min" aria-label="Minimum price" value={minPrice} onChange={(e) => setMinPrice(e.target.value.replace(/[^\d]/g, ""))} />
              <input className={s.input} style={{ width: 80 }} inputMode="numeric" placeholder="Max" aria-label="Maximum price" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d]/g, ""))} />
              <button type="submit" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>Go</button>
            </form>
          </div>
          {loc?.lat != null && (
            <div>
              <h3>Distance</h3>
              <select className={s.select} value={params.get("radiusKm") ?? ""} onChange={(e) => set({ radiusKm: e.target.value || null })} aria-label="Distance">
                <option value="">Any distance</option>
                {[2, 5, 10, 25, 50].map((km) => (
                  <option key={km} value={km}>Within {km} km</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <h3>Brand</h3>
            <select className={s.select} value={params.get("brand") ?? ""} onChange={(e) => set({ brand: e.target.value || null })} aria-label="Brand">
              <option value="">All brands</option>
              {(facets?.brands ?? []).map((b) => (
                <option key={b.name} value={b.name}>{b.name} ({b.products})</option>
              ))}
            </select>
          </div>
          {(q || category || params.get("brand") || params.get("minPrice") || params.get("maxPrice") || params.get("availableOnly") || params.get("onSale")) && (
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => router.replace(pathname)}>Clear all</button>
          )}
        </aside>

        <section aria-label="Products">
          <div className={s.toolbar}>
            <span className={s.count} role="status">
              {data ? `${data.total} product${data.total === 1 ? "" : "s"}` : "Loading…"}
              {loc ? ` · ${loc.label}` : ""}
            </span>
            <label className={s.row} style={{ fontSize: "0.82rem" }}>
              Sort
              <select className={s.select} value={params.get("sort") ?? "relevance"} onChange={(e) => set({ sort: e.target.value === "relevance" ? null : e.target.value })}>
                {SORTS.map(([v, label]) => (
                  <option key={v} value={v} disabled={v === "nearest" && loc?.lat == null}>{label}{v === "nearest" && loc?.lat == null ? " (share location)" : ""}</option>
                ))}
              </select>
            </label>
          </div>
          {data?.relaxed && <p className={`${s.alert} ${s.alertInfo}`} style={{ marginBottom: 12 }}>No product matched every word of “{q}”, so here are products matching some of them.</p>}
          {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
          {q && <FastQueRail q={q} />}
          {data && !loading && data.items.length === 0 ? (
            <div className={s.empty}>
              <strong>Nothing here yet</strong>
              <span>Try another word, a barcode, or fewer filters.</span>
              <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} onClick={() => router.replace(pathname)}>Show everything</button>
            </div>
          ) : (
            <CardGrid items={data?.items ?? null} loading={loading && !data} />
          )}
          {pages > 1 && (
            <nav className={s.row} style={{ justifyContent: "center", marginTop: 20 }} aria-label="Pages">
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>← Previous</button>
              <span className={s.count}>Page {page} of {pages}</span>
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next →</button>
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}
