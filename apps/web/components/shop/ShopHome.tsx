"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ShopHomeDto, ShopProductCardDto } from "@barbercue/shared";
import { apiFetch } from "../../lib/api";
import { locationQuery, useRecent, useShopLocation } from "../../lib/shop/store";
import { CardGrid } from "./ShopParts";
import { FastQueRail } from "../commerce/CommerceParts";
import s from "./shop.module.css";

function Section({ eyebrow, title, sub, href, items, tag }: { eyebrow: string; title: string; sub?: string; href?: string; items: ShopProductCardDto[]; tag?: string }) {
  if (!items.length) return null;
  return (
    <section className={s.section} aria-label={title}>
      <div className={s.sectionHead}>
        <div>
          <div className={s.eyebrow}>{eyebrow}</div>
          <h2 className={s.h2}>{title}</h2>
          {sub && <p className={s.sub}>{sub}</p>}
        </div>
        {href && <Link href={href} className={s.more}>See all ↗</Link>}
      </div>
      <CardGrid items={items} tag={tag} />
    </section>
  );
}

/** Marketplace home: hero, mood categories, and product rails built from real catalog + salon stock. */
export function ShopHome({ initial }: { initial: ShopHomeDto | null }) {
  const loc = useShopLocation();
  const recentIds = useRecent();
  const [data, setData] = useState<ShopHomeDto | null>(initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = locationQuery(loc);
    apiFetch<ShopHomeDto>(`shop/home${qs ? `?${qs}` : ""}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError("The shop could not load. Check your connection and try again."));
  }, [loc, initial]);

  const recent = useMemo(() => {
    if (!data || !recentIds.length) return [];
    const all = [...data.availableNow, ...data.newArrivals, ...data.onSale, ...data.popular];
    const byId = new Map(all.map((p) => [p.id, p]));
    return recentIds.map((id) => byId.get(id)).filter((p): p is ShopProductCardDto => !!p).slice(0, 4);
  }, [data, recentIds]);

  const where = loc?.label && loc.label !== "Near me" ? `in ${loc.label}` : "near you";

  return (
    <main aria-labelledby="shop-hero-title">
      <section className={s.hero}>
        <div className={s.sticker} aria-hidden="true">YOUR<br />GLOW-UP<br />STARTS LOCAL ✦</div>
        <div className={s.heroEyebrow}>FastQue Marketplace · beauty from salons near you</div>
        <h1 id="shop-hero-title" className={s.heroTitle}>
          Look good.
          <br />
          Shop <em>fast.</em>
          <br />
          Glow local.
        </h1>
        <p className={s.heroSub}>Beauty and grooming favourites stocked by salons near you. Compare salon prices, reserve online and pick up nearby — no login, no appointment needed.</p>
        <div className={s.heroCtas}>
          <Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Shop the drop ↗</Link>
          <Link href="/shop/browse?sort=nearest&availableOnly=true" className={`${s.btn} ${s.btnGhost}`}>Explore nearby ↗</Link>
        </div>
        <p className={s.heroNote}>Browse as a guest · Pay at the salon when you pick up</p>
        <div className={s.heroCard}>
          <strong>Your shelf, but better ✨</strong>
          {data ? `${data.stats.products} products · ${data.stats.sellingSalons} salon${data.stats.sellingSalons === 1 ? "" : "s"} selling now` : "Beauty shopping, reimagined for your neighbourhood"}
        </div>
      </section>

      <FastQueRail />
      <div className={s.marquee} aria-hidden="true">
        <span>Shop local</span>
        <span>Compare salon prices</span>
        <span>Pick up nearby</span>
        <span>No login to browse</span>
      </div>

      {error && <p className={`${s.alert} ${s.alertError}`} role="alert" style={{ marginTop: 16 }}>{error}</p>}

      <section className={s.section} aria-label="Categories">
        <div className={s.sectionHead}>
          <div>
            <div className={s.eyebrow}>Find your vibe</div>
            <h2 className={s.h2}>What’s your beauty mood?</h2>
          </div>
          <Link href="/shop/browse" className={s.more}>Explore everything ↗</Link>
        </div>
        <div className={s.cats}>
          {(data?.categories ?? []).map((c) => (
            <Link key={c.slug} href={`/shop/browse?category=${c.slug}`} className={s.cat}>
              <span className={s.catEmoji} aria-hidden="true">{c.emoji}</span>
              <span>
                <span className={s.catLabel}>{c.label}</span>
                <br />
                <span className={s.catCount}>{c.slug === "offers" ? `${c.products} on offer` : `${c.products} products`}</span>
              </span>
              <span className={s.catArrow} aria-hidden="true">↗</span>
            </Link>
          ))}
          {!data && Array.from({ length: 10 }, (_, i) => <div key={i} className={s.skel} style={{ height: 132 }} />)}
        </div>
      </section>

      {data && (
        <>
          <Section eyebrow="Ready to pick up" title={`Available ${where}`} sub="In stock at FastQue partner salons right now." href="/shop/browse?availableOnly=true&sort=nearest" items={data.availableNow} tag="In stock" />
          <Section eyebrow="Deals" title="Special offers" sub="Salon prices below the original price." href="/shop/browse?category=offers" items={data.onSale} tag="Deal" />
          <Section eyebrow="Trending" title="Popular right now" sub="Most ordered in the last 30 days." href="/shop/browse?sort=popular" items={data.popular} tag="Trending" />
          {recent.length > 0 && <Section eyebrow="For you" title="Recently viewed" items={recent} />}
          <Section
            eyebrow="The good stuff"
            title="Your next shelf obsession."
            sub={data.stats.sellingSalons ? "Fresh in the FastQue catalog." : "The FastQue catalog — salons near you are adding stock. Products show prices once a salon sells them."}
            href="/shop/browse?sort=newest"
            items={data.newArrivals}
            tag="New"
          />
        </>
      )}
      {!data && !error && (
        <section className={s.section}>
          <CardGrid items={null} />
        </section>
      )}

      <section className={`${s.section} ${s.promo}`} aria-label="Why Marketplace">
        <div className={s.promoCard}>
          <div className={s.eyebrow}>Neighbourhood energy</div>
          <h3>Love local.<br />Look iconic.</h3>
          <p>Find your beauty staples at salons around the corner and pick them up on your way.</p>
          <Link href="/search" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`}>Discover salons ↗</Link>
          <span className={s.promoEmoji} aria-hidden="true">🛍️</span>
        </div>
        <div className={s.promoCard}>
          <div className={s.eyebrow}>Pro level at home</div>
          <h3>Salon results.<br />Everyday rituals.</h3>
          <p>Professional products your stylist trusts, from the salons that use them.</p>
          <Link href="/shop/browse?category=salon-pro" className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`}>Shop pro picks ↗</Link>
          <span className={s.promoEmoji} aria-hidden="true">🧴</span>
        </div>
      </section>

      <section className={s.cta} aria-label="Book or shop">
        <div>
          <div className={s.eyebrow}>Good looks, zero fuss</div>
          <h2>Come for the glow.<br />Stay for the convenience.</h2>
          <p className={s.sub}>Browse without signing in. Need a haircut too? Book or join a live queue on FastQue.</p>
        </div>
        <div className={s.row}>
          <Link href="/shop/browse" className={`${s.btn} ${s.btnPrimary}`}>Find your next fave ↗</Link>
          <Link href="/search" className={`${s.btn} ${s.btnGhost}`}>Book a salon</Link>
        </div>
      </section>
      <p className={s.footerNote}>Prices and stock come from each salon’s own records. Orders are collected and paid for at the salon. Products marked “Sample product” are FastQue test data.</p>
    </main>
  );
}
