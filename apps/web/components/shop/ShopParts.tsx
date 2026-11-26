"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { DISCOVERY_PATHS, SHOP_BRAND_NAME, type CityDto, type ShopProductCardDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { bagCount, setShopLocation, useBag, useShopLocation, useWishlist, wishlist } from "../../lib/shop/store";
import { useCommerceConfig, useFqBag } from "../../lib/commerce/store";
import { SellerTabs } from "../commerce/CommerceParts";
import s from "./shop.module.css";

export const rupees = (v: string | number | null | undefined) =>
  v == null ? "—" : `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(v))}`;

// ---------- Packshot (illustrated product visual until real photos exist) ----------

const PALETTES: Array<[string, string, string, string]> = [
  ["#f3d9e4", "#fff4f8", "#2a1f33", "#1b1624"],
  ["#e7d7f7", "#fbf6ff", "#251d36", "#18132a"],
  ["#ffd8cf", "#fff3ef", "#2e1d1f", "#1d1416"],
  ["#d8efe2", "#f4fff8", "#1d2a24", "#141c18"],
  ["#fbe7c6", "#fffaf0", "#2e2618", "#1d1810"],
  ["#d9e6fb", "#f5f9ff", "#1c2333", "#131826"],
  ["#f6c9d6", "#ffeef3", "#331a26", "#21111a"],
];
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
function shapeFor(category: string | null, name: string): string {
  const t = `${category ?? ""} ${name}`.toLowerCase();
  if (/lipstick|kajal|pencil|stick|deodorant/.test(t)) return s.packStick;
  if (/mask|cream|butter|wax|pomade|scrub|balm|powder|kit|salt/.test(t)) return s.packJar;
  if (/gel|tube|foam|concealer|lotion|wash|cleanser|foundation/.test(t)) return s.packTube;
  if (/scissor|comb|brush|clip|file|pumice|capes|gloves|towels|strips|pads|foil|wipes|sponges|razor/.test(t)) return s.packBox;
  return s.packBottle;
}

export function Packshot({ product, large }: { product: { id: string; name: string; brand: string | null; category: string | null; imageUrl?: string | null }; large?: boolean }) {
  const [a, b, bgA, bgB] = PALETTES[hash(product.id) % PALETTES.length];
  return (
    <div className={s.shot} style={{ ["--shot-a" as string]: bgA, ["--shot-b" as string]: bgB, ...(large ? { aspectRatio: "1 / 0.85" } : {}) }} aria-hidden="true">
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- catalog photos are arbitrary https URLs
        <img src={product.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className={`${s.pack} ${shapeFor(product.category, product.name)}`} style={{ ["--pack-a" as string]: a, ["--pack-b" as string]: b, ...(large ? { transform: "scale(1.15)" } : {}) }}>
          <span>
            <strong>{(product.brand ?? "FastQue").split(" ")[0]}</strong>
            <small>{product.name.slice(0, 18)}</small>
          </span>
        </div>
      )}
    </div>
  );
}

// ---------- Product card ----------

export function ProductCard({ product, tag }: { product: ShopProductCardDto; tag?: string }) {
  const wish = useWishlist();
  const { user } = useAuth();
  const isCustomer = !!user?.roles.includes("CUSTOMER");
  const on = wish.includes(product.id);
  return (
    <article className={s.card}>
      {(tag || product.isTestData) && <span className={`${s.cardTag} ${product.isTestData ? s.cardTagTest : ""}`}>{product.isTestData ? "Sample product" : tag}</span>}
      <button type="button" className={`${s.heart} ${on ? s.heartOn : ""}`} aria-pressed={on} aria-label={on ? `Remove ${product.name} from wishlist` : `Save ${product.name} to wishlist`} onClick={() => toggleWish(product.id, isCustomer)}>
        {on ? "♥" : "♡"}
      </button>
      <Link href={`/shop/p/${product.id}`} className={s.cardLink}>
        <Packshot product={product} />
        <div className={s.cardBody}>
          <span className={s.cardBrand}>{product.brand ?? "FastQue"}</span>
          <span className={s.cardName}>{product.name}</span>
          <span className={s.cardMeta}>{[product.variant, product.category].filter(Boolean).join(" · ")}</span>
          {product.fromPrice ? (
            <div className={s.priceRow}>
              <span className={s.price}>{product.sellerCount > 1 ? "from " : ""}{rupees(product.fromPrice)}</span>
              {product.compareAtPrice && <span className={s.strike}>{rupees(product.compareAtPrice)}</span>}
              {product.discountPercent ? (
                <span className={s.off}>{product.discountPercent}% OFF</span>
              ) : product.maxDiscountPercent ? (
                <span className={s.off}>Up to {product.maxDiscountPercent}% off</span>
              ) : null}
            </div>
          ) : (
            <div className={s.priceRow}>
              <span className={s.cardMeta}>{product.mrp ? `MRP ${rupees(product.mrp)} · ` : ""}Not sold nearby yet</span>
            </div>
          )}
          <div className={s.avail}>
            <span className={`${s.dot} ${product.inStock ? s.dotOk : ""}`}>
              {product.inStock ? `${product.sellerCount} salon${product.sellerCount === 1 ? "" : "s"}${product.nearestKm != null ? ` · ${product.nearestKm} km` : ""}` : "Coming to salons"}
            </span>
            {product.inStock && <span className={s.off}>Pickup →</span>}
          </div>
        </div>
      </Link>
    </article>
  );
}

/** Signed-in customers' wishlist is saved on their account too (best effort); guests keep it on the device. */
export function toggleWish(productId: string, isCustomer: boolean) {
  const on = wishlist.toggle(productId);
  if (isCustomer) void apiFetch(`customer/shop/wishlist/${productId}`, { method: on ? "PUT" : "DELETE" }).catch(() => undefined);
}

export function CardGrid({ items, tag, loading }: { items: ShopProductCardDto[] | null; tag?: string; loading?: boolean }) {
  if (!items || loading)
    return (
      <div className={s.grid} aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={s.skel} style={{ height: 300 }} />
        ))}
      </div>
    );
  return (
    <div className={s.grid}>
      {items.map((p) => (
        <ProductCard key={p.id} product={p} tag={tag} />
      ))}
    </div>
  );
}

// ---------- Location picker ----------

export function LocationButton() {
  const loc = useShopLocation();
  const [open, setOpen] = useState(false);
  const [cities, setCities] = useState<CityDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && !cities) apiFetch<CityDto[]>(DISCOVERY_PATHS.cities).then(setCities).catch(() => setCities([]));
  }, [open, cities]);
  function useDevice() {
    setError(null);
    if (!("geolocation" in navigator)) return setError("This browser cannot share a location.");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setShopLocation({ lat: p.coords.latitude, lng: p.coords.longitude, label: "Near me" });
        setOpen(false);
      },
      () => setError("Location permission was not given. Pick a city instead."),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
    );
  }
  return (
    <div style={{ position: "relative" }}>
      <button type="button" className={s.locBtn} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
        📍 <span>{loc?.label ?? "Set location"}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Choose your location" className={s.panel} style={{ position: "absolute", right: 0, top: 48, zIndex: 40, width: 280, display: "grid", gap: 10 }}>
          <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} onClick={useDevice}>Use my current location</button>
          <label className={s.field}>
            Or choose a city
            <select
              className={s.select}
              value={loc?.citySlug ?? ""}
              onChange={(e) => {
                const city = cities?.find((c) => c.slug === e.target.value);
                setShopLocation(city ? { citySlug: city.slug, label: city.name } : null);
                setOpen(false);
              }}
            >
              <option value="">All cities</option>
              {(cities ?? []).map((c) => (
                <option key={c.id} value={c.slug}>{c.name}</option>
              ))}
            </select>
          </label>
          {loc && <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSm}`} onClick={() => { setShopLocation(null); setOpen(false); }}>Clear location</button>}
          {error && <p className={`${s.alert} ${s.alertError}`}>{error}</p>}
        </div>
      )}
    </div>
  );
}

// ---------- Page frame ----------

const LINKS = [
  { href: "/shop", label: "Home" },
  { href: "/shop/browse", label: "Shop all" },
  { href: "/shop/browse?category=offers", label: "Deals" },
  { href: "/shop/browse?sort=nearest&availableOnly=true", label: "Near me" },
  { href: "/shop/orders", label: "My orders" },
];

export function ShopFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const items = useBag();
  const fqItems = useFqBag();
  const commerce = useCommerceConfig();
  const wish = useWishlist();
  const [q, setQ] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    const text = q.trim();
    router.push(text ? `/shop/browse?q=${encodeURIComponent(text)}` : "/shop/browse");
  }
  const count = bagCount(items) + (commerce.enabled ? fqItems.reduce((n, l) => n + l.quantity, 0) : 0);
  return (
    <div className={s.page}>
      <div className={s.ticker} aria-hidden="true">
        <b>✦</b> {SHOP_BRAND_NAME} by FastQue <b>✦</b> Beauty from salons near you · Pick up nearby <b>✦</b>
      </div>
      <header className={s.nav}>
        <div className={`${s.wrap} ${s.navRow}`}>
          <Link href="/shop" className={s.brand} aria-label={`FastQue ${SHOP_BRAND_NAME} home`}>
            Fast<em>Que</em> <span className={s.brandTag}>MARKETPLACE</span>
          </Link>
          <nav className={s.navLinks} aria-label="Shop sections">
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>{l.label}</Link>
            ))}
          </nav>
          <form className={s.search} role="search" onSubmit={submit}>
            <span aria-hidden="true">🔎</span>
            <label htmlFor="shop-q" className={s.srOnly}>Search products, brands or barcodes</label>
            <input id="shop-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your next obsession…" maxLength={120} />
          </form>
          <LocationButton />
          <Link href="/shop/wishlist" className={s.iconBtn} aria-label={`Wishlist, ${wish.length} saved`}>
            ♡{wish.length > 0 && <span className={s.badge}>{wish.length}</span>}
          </Link>
          <Link href="/shop/bag" className={s.iconBtn} aria-label={`Bag, ${count} item${count === 1 ? "" : "s"}`}>
            🛍{count > 0 && <span className={s.badge}>{count}</span>}
          </Link>
        </div>
      </header>
      <div className={s.wrap}>
        <SellerTabs />
        {children}
      </div>
    </div>
  );
}
