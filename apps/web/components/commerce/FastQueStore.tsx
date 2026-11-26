"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { CommerceHomeDto, CommercePageDto, CommerceProductDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useCommerceConfig } from "../../lib/commerce/store";
import { errText, FastQueGrid, PinCheck } from "./CommerceParts";
import { Banners, PersonalRails } from "./FastQueExtras";
import s from "../shop/shop.module.css";
import c from "./commerce.module.css";

function Rail({ title, eyebrow, items }: { title: string; eyebrow: string; items: CommerceProductDto[] }) {
  if (!items.length) return null;
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}>
        <div>
          <div className={s.eyebrow}>{eyebrow}</div>
          <h2 className={s.h2}>{title}</h2>
        </div>
      </div>
      <FastQueGrid items={items} />
    </section>
  );
}

const FILTERS = ["q", "category", "brand", "minPrice", "maxPrice", "availableOnly", "onSale", "sort", "page"] as const;

/** FastQue's own shop: rails from real listings, and a filterable product list. */
export function FastQueStore() {
  const cfg = useCommerceConfig();
  const params = useSearchParams();
  const router = useRouter();
  const [home, setHome] = useState<CommerceHomeDto | null>(null);
  const [page, setPage] = useState<CommercePageDto<CommerceProductDto> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams();
  for (const k of FILTERS) if (params.get(k)) qs.set(k, params.get(k)!);
  const query = qs.toString();

  useEffect(() => {
    if (cfg.enabled) apiFetch<CommerceHomeDto>("commerce/home").then(setHome).catch(() => setHome(null));
  }, [cfg.enabled]);
  useEffect(() => {
    if (!cfg.enabled) return;
    let live = true;
    apiFetch<CommercePageDto<CommerceProductDto>>(`commerce/products?${query}`)
      .then((r) => {
        if (!live) return;
        setPage(r);
        setError(null);
      })
      .catch((e) => live && setError(errText(e, "Products could not load.")));
    return () => {
      live = false;
    };
  }, [cfg.enabled, query]);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(query);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    router.replace(`/shop/fastque?${n.toString()}`, { scroll: false });
  };
  if (!cfg.enabled)
    return (
      <main style={{ paddingTop: 24 }}>
        <div className={s.empty}>
          <strong>FastQue delivery is not open yet</strong>
          <Link href="/shop" className={`${s.btn} ${s.btnPrimary}`}>Shop from salons</Link>
        </div>
      </main>
    );
  const pages = page ? Math.ceil(page.total / page.pageSize) : 0;
  return (
    <main aria-labelledby="fq-title">
      <section className={s.hero}>
        <div className={s.heroEyebrow}>Sold and delivered by FastQue</div>
        <h1 id="fq-title" className={s.heroTitle}>
          Salon care, <em>home.</em>
        </h1>
        <p className={s.heroSub}>Products FastQue sells itself, delivered to your door. Pay cash when they arrive.</p>
        <PinCheck />
      </section>
      {home && !query && (
        <>
          <Banners />
          {home.categories.length > 0 && (
            <section className={s.section} aria-label="Shop by category">
              <div className={s.chips}>
                {home.categories.map((x) => (
                  <button key={x.name} type="button" className={s.chip} onClick={() => set("category", x.name)}>{x.name} ({x.products})</button>
                ))}
              </div>
              <div className={s.chips} style={{ marginTop: 8 }}>
                {home.brands.map((x) => (
                  <button key={x.name} type="button" className={s.chip} onClick={() => set("brand", x.name)}>{x.name}</button>
                ))}
              </div>
            </section>
          )}
          <Rail eyebrow="Picked by FastQue" title="Featured" items={home.featured} />
          <Rail eyebrow="From recent orders" title="Best sellers" items={home.bestSellers} />
          <Rail eyebrow="Below MRP" title="Offers" items={home.offers} />
          <Rail eyebrow="Just added" title="New arrivals" items={home.newArrivals} />
          <PersonalRails />
        </>
      )}
      <section className={s.section} aria-label="All FastQue products">
        <div className={s.toolbar}>
          <h2 className={s.h2}>All FastQue products</h2>
          <div className={s.row}>
            <label className={s.check}><input type="checkbox" checked={params.get("availableOnly") === "true"} onChange={(e) => set("availableOnly", e.target.checked ? "true" : "")} /> In stock</label>
            <label className={s.check}><input type="checkbox" checked={params.get("onSale") === "true"} onChange={(e) => set("onSale", e.target.checked ? "true" : "")} /> On offer</label>
            <input className={s.input} aria-label="Search FastQue products" placeholder="Search" defaultValue={params.get("q") ?? ""} key={params.get("q") ?? ""} onKeyDown={(e) => e.key === "Enter" && set("q", e.currentTarget.value.trim())} />
            <select className={s.select} aria-label="Sort" value={params.get("sort") ?? "relevance"} onChange={(e) => set("sort", e.target.value === "relevance" ? "" : e.target.value)}>
              <option value="relevance">Relevance</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="newest">Newest</option>
              <option value="popular">Most ordered</option>
            </select>
          </div>
        </div>
        {(params.get("category") || params.get("brand") || params.get("q")) && (
          <div className={s.chips} style={{ marginBottom: 12 }}>
            {(["q", "category", "brand"] as const).map((k) => params.get(k) && <button key={k} type="button" className={`${s.chip} ${s.chipOn}`} onClick={() => set(k, "")}>{params.get(k)} ✕</button>)}
          </div>
        )}
        {error && <p className={`${s.alert} ${s.alertError}`} role="alert">{error}</p>}
        {!page && !error && <div className={s.skel} style={{ height: 240 }} />}
        {page && page.total === 0 && <div className={s.empty}><strong>Nothing here yet</strong><span>No FastQue product matches. Try fewer filters, or shop from salons.</span></div>}
        {page && page.total > 0 && <FastQueGrid items={page.items} />}
        {pages > 1 && (
          <div className={s.row} style={{ justifyContent: "center", marginTop: 16 }}>
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={page!.page <= 1} onClick={() => set("page", String(page!.page - 1))}>← Previous</button>
            <span className={s.count}>Page {page!.page} of {pages}</span>
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} disabled={page!.page >= pages} onClick={() => set("page", String(page!.page + 1))}>Next →</button>
          </div>
        )}
      </section>
      {cfg.seller && (
        <footer className={c.group} style={{ marginTop: 32 }}>
          <strong>Seller: {cfg.seller.legalName ?? cfg.seller.name}</strong>
          <span className={s.cardMeta}>{[cfg.seller.address, cfg.seller.gstin ? `GSTIN ${cfg.seller.gstin}` : null, cfg.seller.supportEmail, cfg.seller.supportPhone].filter(Boolean).join(" · ")}</span>
          {cfg.seller.grievance && <span className={s.cardMeta}>Grievance: {cfg.seller.grievance}</span>}
          {cfg.seller.returnPolicy && <span className={s.cardMeta}>{cfg.seller.returnPolicy}</span>}
        </footer>
      )}
    </main>
  );
}
