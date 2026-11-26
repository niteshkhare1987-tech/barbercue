"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ShopOfferDto, ShopProductDetailDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { bag, locationQuery, rememberViewed, useShopLocation, useWishlist } from "../../lib/shop/store";
import { BarcodeSvg } from "../inventory/ProductCodes";
import { CardGrid, Packshot, rupees, toggleWish } from "./ShopParts";
import { useCommerceConfig } from "../../lib/commerce/store";
import { FastQueOffer } from "../commerce/CommerceParts";
import s from "./shop.module.css";

const AVAIL: Record<ShopOfferDto["availability"], string> = { IN_STOCK: "In stock", LOW_STOCK: "Few left", OUT_OF_STOCK: "Out of stock" };

/** Product page: details, barcode, and every salon selling it — choose the salon you buy from. */
export function ShopProduct({ initial }: { initial: ShopProductDetailDto }) {
  const loc = useShopLocation();
  const wish = useWishlist();
  const { user } = useAuth();
  const { multiSellerCart } = useCommerceConfig();
  const [p, setP] = useState(initial);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<{ tone: "ok" | "info" | "error"; text: string; replace?: ShopOfferDto } | null>(null);

  useEffect(() => {
    rememberViewed(initial.id);
  }, [initial.id]);
  // The server-rendered page may be up to a minute old; prices and stock are always re-read live.
  useEffect(() => {
    const lq = locationQuery(loc);
    apiFetch<ShopProductDetailDto>(`shop/products/${initial.id}${lq ? `?${lq}` : ""}`).then(setP).catch(() => undefined);
  }, [loc, initial.id]);

  const lineFor = (o: ShopOfferDto) => ({
    listingId: o.listingId,
    productId: p.id,
    salonId: o.salon.id,
    salonName: o.salon.name,
    name: p.name,
    brand: p.brand,
    variant: p.variant,
    category: p.category,
    quantity: qty[o.listingId] ?? 1,
    price: o.price,
  });
  function add(o: ShopOfferDto) {
    const result = multiSellerCart ? bag.addAny(lineFor(o)) : bag.add(lineFor(o));
    if (result === "other-salon")
      setNotice({ tone: "info", text: `Your bag has products from another salon. One order is collected from one salon.`, replace: o });
    else setNotice({ tone: "ok", text: `Added to your bag from ${o.salon.name}.` });
  }
  const live = p.offers.filter((o) => o.availableQuantity > 0);
  const best = live.length ? live.reduce((m, o) => (Number(o.price) < Number(m.price) ? o : m)) : null;
  const saved = wish.includes(p.id);

  return (
    <main style={{ paddingTop: 16 }} aria-labelledby="pdp-title">
      <nav className={s.count} aria-label="Breadcrumb">
        <Link href="/shop">Marketplace</Link> › <Link href="/shop/browse">Shop all</Link>
        {p.category ? <> › <Link href={`/shop/browse?q=${encodeURIComponent(p.category)}`}>{p.category}</Link></> : null}
      </nav>
      <div className={s.pdp}>
        <div className={s.pdpShot}>
          <Packshot product={p} large />
        </div>
        <div>
          <div className={s.cardBrand}>{p.brand ?? "FastQue"}</div>
          <h1 id="pdp-title" className={s.pdpTitle}>{p.name}</h1>
          <div className={s.cardMeta}>{[p.variant, p.category, p.subcategory].filter(Boolean).join(" · ")}</div>
          {p.isTestData && <p className={`${s.alert} ${s.alertInfo}`} style={{ marginTop: 10 }}>Sample product from FastQue test data — not a real branded product.</p>}
          <div className={s.priceRow} style={{ marginTop: 12 }}>
            {best ? (
              <>
                <span className={s.price} style={{ fontSize: "1.6rem" }}>{live.length > 1 ? "from " : ""}{rupees(best.price)}</span>
                {best.compareAtPrice && <span className={s.strike}>{rupees(best.compareAtPrice)}</span>}
                {best.discountPercent ? <span className={s.off}>{best.discountPercent}% OFF</span> : null}
              </>
            ) : (
              <span className={s.sub}>{p.mrp ? `MRP ${rupees(p.mrp)} · ` : ""}No salon sells this yet.</span>
            )}
          </div>
          <div className={s.row} style={{ marginTop: 14 }}>
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} aria-pressed={saved} onClick={() => toggleWish(p.id, !!user?.roles.includes("CUSTOMER"))}>
              {saved ? "♥ Saved" : "♡ Save to wishlist"}
            </button>
          </div>

          <FastQueOffer productId={p.id} />

          <h2 className={s.h2} style={{ fontSize: "1.2rem", marginTop: 22 }}>Choose your salon</h2>
          <p className={s.sub}>{loc ? `Sellers ${loc.lat != null ? "nearest to you first" : `in ${loc.label}`}.` : "Set your location (top bar) to see the nearest salons first."} Collect from the salon and pay there.</p>
          {notice && (
            <div className={`${s.alert} ${notice.tone === "ok" ? s.alertOk : notice.tone === "info" ? s.alertInfo : s.alertError}`} role="status" style={{ marginTop: 10 }}>
              {notice.text}{" "}
              {notice.tone === "ok" && <Link href="/shop/bag"><strong>View bag →</strong></Link>}
              {notice.replace && (
                <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} style={{ marginLeft: 8 }} onClick={() => { bag.replaceWith(lineFor(notice.replace!)); setNotice({ tone: "ok", text: `Bag replaced with this item from ${notice.replace!.salon.name}.` }); }}>
                  Start a new bag here
                </button>
              )}
            </div>
          )}
          <div className={s.offers}>
            {p.offers.length === 0 && <div className={s.empty}><strong>Coming soon to salons</strong><span>Salons can add this product to their FastQue shop from their dashboard.</span></div>}
            {p.offers.map((o) => {
              const n = qty[o.listingId] ?? 1;
              const max = Math.min(o.maxPerOrder, o.availableQuantity);
              return (
                <div key={o.listingId} className={`${s.offer} ${best?.listingId === o.listingId ? s.offerBest : ""}`}>
                  <div>
                    <h4>{o.salon.name} {best?.listingId === o.listingId && live.length > 1 && <span className={s.off}>· Best price</span>}</h4>
                    <div className={s.cardMeta}>
                      {[o.salon.locality, o.salon.city].filter(Boolean).join(", ")}
                      {o.distanceKm != null ? ` · ${o.distanceKm} km away` : ""}
                    </div>
                    <div className={s.priceRow}>
                      <span className={s.price}>{rupees(o.price)}</span>
                      {o.compareAtPrice && <span className={s.strike}>{rupees(o.compareAtPrice)}</span>}
                      {o.discountPercent ? <span className={s.off}>{o.discountPercent}% OFF</span> : null}
                    </div>
                    <span className={`${s.dot} ${o.availability === "IN_STOCK" ? s.dotOk : o.availability === "LOW_STOCK" ? s.dotWarn : ""}`} style={{ fontSize: "0.75rem" }}>
                      {AVAIL[o.availability]}{o.availability === "LOW_STOCK" ? ` (${o.availableQuantity})` : ""} · {o.pickup ? "Pickup at salon" : "Pickup unavailable"} · Delivery not offered yet
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: 8, justifyItems: "end" }}>
                    {max > 0 && o.pickup && (
                      <div className={s.qty} aria-label={`Quantity from ${o.salon.name}`}>
                        <button type="button" aria-label="Less" onClick={() => setQty({ ...qty, [o.listingId]: Math.max(1, n - 1) })}>−</button>
                        <span>{n}</span>
                        <button type="button" aria-label="More" onClick={() => setQty({ ...qty, [o.listingId]: Math.min(max, n + 1) })}>+</button>
                      </div>
                    )}
                    <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={max <= 0 || !o.pickup} onClick={() => add(o)}>
                      {max <= 0 ? "Out of stock" : "Add to bag"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className={s.facts}>
            {p.barcodes[0] && (
              <div className={s.fact} style={{ gridColumn: "1 / -1" }}>
                <span>Barcode ({p.barcodes[0].symbology})</span>
                <div style={{ marginTop: 6, maxWidth: 260 }}><BarcodeSvg value={p.barcodes[0].display} height={44} /></div>
              </div>
            )}
            {p.packSize && p.packUnit && <div className={s.fact}><span>Size</span>{Number(p.packSize)} {p.packUnit.toLowerCase()}</div>}
            {p.manufacturer && <div className={s.fact}><span>Manufacturer</span>{p.manufacturer}</div>}
            <div className={s.fact}><span>Pickup</span>Collect at the salon you choose</div>
            <div className={s.fact}><span>Payment</span>Pay at the salon on pickup</div>
          </div>
          {p.description && <p className={s.sub} style={{ lineHeight: 1.6 }}>{p.description}</p>}
          <p className={s.cardMeta}>A barcode identifies the product, not its condition or expiry — check the pack when you collect it.</p>
        </div>
      </div>
      {p.related.length > 0 && (
        <section className={s.section} aria-label="Related products">
          <div className={s.sectionHead}>
            <div>
              <div className={s.eyebrow}>You may also like</div>
              <h2 className={s.h2}>More in {p.category}</h2>
            </div>
          </div>
          <CardGrid items={p.related} />
        </section>
      )}
    </main>
  );
}
