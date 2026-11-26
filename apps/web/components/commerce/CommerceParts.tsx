"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { CommercePageDto, CommerceProductDto, CommerceServiceabilityDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { useWishlist } from "../../lib/shop/store";
import { fqBag, lineOf, setFqPin, useCommerceConfig, useFqPin } from "../../lib/commerce/store";
import { BagSync, FastQueProductExtras, Stars } from "./FastQueExtras";
import { Packshot, rupees, toggleWish } from "../shop/ShopParts";
import s from "../shop/shop.module.css";
import c from "./commerce.module.css";

export const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message || fallback : fallback);
const AVAIL = { IN_STOCK: "In stock", LOW_STOCK: "Few left", OUT_OF_STOCK: "Out of stock" } as const;

/** All products | Shop from FastQue | Shop from salons. Nothing at all while direct commerce is off. */
export function SellerTabs() {
  const cfg = useCommerceConfig();
  const path = usePathname() ?? "";
  if (!cfg.enabled) return null;
  const tabs = [
    { href: "/shop", label: "All products", on: path === "/shop" || path.startsWith("/shop/p/") },
    { href: "/shop/fastque", label: "🚚 Shop from FastQue", on: path.startsWith("/shop/fastque") },
    { href: "/shop/browse?availableOnly=true", label: "💈 Shop from salons", on: path.startsWith("/shop/browse") },
  ];
  return (
    <>
    <BagSync />
    <nav className={c.tabs} aria-label="Choose who to buy from">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={`${c.tab} ${t.on ? c.tabOn : ""}`} aria-current={t.on ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
    </>
  );
}

export function SoldByFastQue({ cod = true }: { cod?: boolean }) {
  return (
    <div className={c.soldBy}>
      <strong>Sold by FastQue</strong>
      <span>Home Delivery{cod ? " | Cash on Delivery" : ""}</span>
    </div>
  );
}

export function FastQueCard({ p }: { p: CommerceProductDto }) {
  const wish = useWishlist();
  const { user } = useAuth();
  const [added, setAdded] = useState(false);
  const on = wish.includes(p.productId);
  const out = p.availability === "OUT_OF_STOCK";
  return (
    <article className={s.card}>
      <span className={`${s.cardTag} ${c.fqTag}`}>FastQue</span>
      <button type="button" className={`${s.heart} ${on ? s.heartOn : ""}`} aria-pressed={on} aria-label={on ? `Remove ${p.name} from wishlist` : `Save ${p.name} to wishlist`} onClick={() => toggleWish(p.productId, !!user?.roles.includes("CUSTOMER"))}>
        {on ? "♥" : "♡"}
      </button>
      <Link href={`/shop/p/${p.productId}`} className={s.cardLink}>
        <Packshot product={{ id: p.productId, name: p.name, brand: p.brand, category: p.category, imageUrl: p.imageUrl }} />
        <div className={s.cardBody}>
          <span className={s.cardBrand}>{p.brand ?? ""}</span>
          <span className={s.cardName}>{p.name}</span>
          <span className={s.cardMeta}>{[p.variant, p.category].filter(Boolean).join(" · ")}</span>
          <div className={s.priceRow}>
            <span className={s.price}>{rupees(p.price)}</span>
            {p.discountPercent ? (
              <>
                <span className={s.strike}>MRP {rupees(p.mrp)}</span>
                <span className={s.off}>{p.discountPercent}% OFF</span>
              </>
            ) : null}
          </div>
          {p.rating && <Stars average={p.rating.average} count={p.rating.count} />}
          <SoldByFastQue cod={p.codEligible} />
          <span className={`${s.dot} ${p.availability === "IN_STOCK" ? s.dotOk : p.availability === "LOW_STOCK" ? s.dotWarn : ""}`} style={{ fontSize: "0.75rem" }}>{AVAIL[p.availability]}</span>
        </div>
      </Link>
      <div className={c.cardFoot}>
        <button
          type="button"
          className={`${s.btn} ${added ? s.btnGhost : s.btnPrimary} ${s.btnSm} ${s.btnBlock}`}
          disabled={out}
          onClick={() => {
            fqBag.add(lineOf(p));
            setAdded(true);
          }}
        >
          {out ? "Out of stock" : added ? "Added ✓ · add another" : "Add to bag"}
        </button>
      </div>
    </article>
  );
}

export function FastQueGrid({ items }: { items: CommerceProductDto[] }) {
  return (
    <div className={s.grid}>
      {items.map((p) => (
        <FastQueCard key={p.listingId} p={p} />
      ))}
    </div>
  );
}

/** FastQue's own products inside the existing marketplace pages. Renders nothing when off or empty. */
export function FastQueRail({ q }: { q?: string }) {
  const cfg = useCommerceConfig();
  const [items, setItems] = useState<CommerceProductDto[]>([]);
  useEffect(() => {
    if (!cfg.enabled) return;
    let live = true;
    apiFetch<CommercePageDto<CommerceProductDto>>(`commerce/products?limit=4${q ? `&q=${encodeURIComponent(q.slice(0, 120))}` : "&availableOnly=true"}`)
      .then((r) => live && setItems(r.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cfg.enabled, q]);
  if (!cfg.enabled || !items.length) return null;
  return (
    <section className={s.section} aria-label="Sold by FastQue">
      <div className={s.sectionHead}>
        <div>
          <div className={s.eyebrow}>Delivered to your home</div>
          <h2 className={s.h2}>Shop from FastQue</h2>
        </div>
        <Link href={q ? `/shop/fastque?q=${encodeURIComponent(q)}` : "/shop/fastque"} className={s.more}>See all ↗</Link>
      </div>
      <FastQueGrid items={items} />
    </section>
  );
}

/** FastQue's offer on a product page, beside the salons' offers, with the total to the shopper's door. */
export function FastQueOffer({ productId }: { productId: string }) {
  const cfg = useCommerceConfig();
  const pin = useFqPin();
  const [offer, setOffer] = useState<CommerceProductDto | null>(null);
  const [area, setArea] = useState<CommerceServiceabilityDto | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!cfg.enabled) return;
    let live = true;
    apiFetch<{ offer: CommerceProductDto | null }>(`commerce/products/${productId}/offer`)
      .then((r) => live && setOffer(r.offer))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [cfg.enabled, productId]);
  if (!cfg.enabled || !offer) return null;
  const out = offer.availability === "OUT_OF_STOCK";
  const goods = Number(offer.price) * qty;
  const delivery = area?.serviceable ? (area.freeAbove && goods >= Number(area.freeAbove) ? 0 : Number(area.deliveryCharge)) : null;
  return (
    <section aria-label="Buy from FastQue" className={c.offer}>
      <SoldByFastQue cod={offer.codEligible && cfg.cod} />
      <div className={s.priceRow}>
        <span className={s.price} style={{ fontSize: "1.5rem" }}>{rupees(offer.price)}</span>
        {offer.discountPercent ? (
          <>
            <span className={s.strike}>MRP {rupees(offer.mrp)}</span>
            <span className={s.off}>{offer.discountPercent}% OFF</span>
          </>
        ) : null}
        <span className={`${s.dot} ${out ? "" : s.dotOk}`}>{AVAIL[offer.availability]}</span>
      </div>
      <PinCheck key={pin} onResult={setArea} />
      {delivery != null && (
        <p className={c.door}>
          Product {rupees(goods)} + delivery {delivery === 0 ? "free" : rupees(delivery)} = <strong>{rupees(goods + delivery)} at your door</strong>
        </p>
      )}
      <div className={s.row}>
        <div className={s.qty} aria-label="Quantity">
          <button type="button" aria-label="Less" onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <span>{qty}</span>
          <button type="button" aria-label="More" disabled={qty >= offer.availableQuantity} onClick={() => setQty(qty + 1)}>+</button>
        </div>
        <button
          type="button"
          className={`${s.btn} ${s.btnPrimary}`}
          disabled={out}
          onClick={() => {
            fqBag.add(lineOf(offer, qty));
            setAdded(true);
          }}
        >
          {out ? "Out of stock" : "Add to bag"}
        </button>
        {added && <Link href="/shop/bag" className={s.more}>Added ✓ View bag →</Link>}
      </div>
      <p className={s.cardMeta}>{offer.returnable ? `Returns within ${offer.returnWindowDays} days of delivery.` : "This product cannot be returned."}</p>
      <FastQueProductExtras key={offer.listingId} offer={offer} />
    </section>
  );
}

export function PinCheck({ onResult }: { onResult?: (r: CommerceServiceabilityDto | null) => void }) {
  const saved = useFqPin();
  const [pin, setPin] = useState(saved);
  const [res, setRes] = useState<CommerceServiceabilityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function check(value: string) {
    setError(null);
    if (!/^[1-9]\d{5}$/.test(value)) return setError("Enter a 6-digit PIN code.");
    try {
      const r = await apiFetch<CommerceServiceabilityDto>(`commerce/serviceability?pin=${value}`);
      setRes(r);
      onResult?.(r);
      if (value !== saved) setFqPin(value);
    } catch (e) {
      setError(errText(e, "Delivery could not be checked."));
    }
  }
  useEffect(() => {
    if (!/^[1-9]\d{5}$/.test(saved)) return;
    let live = true;
    apiFetch<CommerceServiceabilityDto>(`commerce/serviceability?pin=${saved}`)
      .then((r) => {
        if (!live) return;
        setRes(r);
        onResult?.(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check the remembered PIN once
  }, []);
  return (
    <form
      className={c.pin}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void check(pin.trim());
      }}
    >
      <input className={s.input} aria-label="Delivery PIN code" inputMode="numeric" maxLength={6} placeholder="PIN code" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
      <button type="submit" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`}>Check</button>
      <span role="status" className={error || (res && !res.serviceable) ? c.bad : c.good}>{error ?? res?.message ?? ""}</span>
    </form>
  );
}
