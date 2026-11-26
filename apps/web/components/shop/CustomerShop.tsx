"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SHOP_ORDER_STATUS_LABEL, type ShopOrderDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { useRecent, useWishlist } from "../../lib/shop/store";
import { FastQueOrders } from "../commerce/FastQueOrder";

const inr = (v: string) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(v))}`;
const OPEN = new Set(["PLACED", "ACCEPTED", "PREPARING", "READY_FOR_PICKUP"]);

const card: React.CSSProperties = { padding: 16, borderRadius: 16, border: "1px solid var(--bc-border, #e7e0d3)", background: "var(--bc-surface, #fff)" };
const btn: React.CSSProperties = { display: "inline-flex", alignItems: "center", minHeight: 40, padding: "0 16px", borderRadius: 999, background: "var(--bc-brand-gradient)", color: "#fff", fontWeight: 800, textDecoration: "none", border: 0, cursor: "pointer" };
const ghost: React.CSSProperties = { ...btn, background: "transparent", color: "inherit", border: "1px solid var(--bc-border, #e7e0d3)" };

/** Customer dashboard → Marketplace: orders (track / reorder), wishlist and a way into the shop. */
export function CustomerShop() {
  const [orders, setOrders] = useState<ShopOrderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wish = useWishlist();
  const recent = useRecent();
  useEffect(() => {
    apiFetch<ShopOrderDto[]>("customer/shop/orders").then(setOrders).catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your orders."));
  }, []);

  const open = (orders ?? []).filter((o) => OPEN.has(o.status));
  const past = (orders ?? []).filter((o) => !OPEN.has(o.status));
  return (
    <main style={{ display: "grid", gap: 16, padding: "8px 0 32px" }} aria-labelledby="cs-title">
      <section style={{ ...card, background: "linear-gradient(120deg, #1a1533, #2a1424)", color: "#fff", border: 0 }}>
        <div style={{ fontSize: "0.7rem", letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 900, color: "#ff7a3d" }}>FastQue Marketplace</div>
        <h1 id="cs-title" style={{ margin: "6px 0", fontSize: "1.8rem" }}>Shop beauty from salons near you ✨</h1>
        <p style={{ margin: "0 0 14px", opacity: 0.8 }}>Reserve online, collect and pay at the salon. No appointment needed.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href="/shop" style={btn}>Open Marketplace ↗</Link>
          <Link href="/shop/wishlist" style={{ ...ghost, color: "#fff", borderColor: "rgba(255,255,255,0.35)" }}>Wishlist ({wish.length})</Link>
          {recent.length > 0 && <Link href={`/shop/p/${recent[0]}`} style={{ ...ghost, color: "#fff", borderColor: "rgba(255,255,255,0.35)" }}>Recently viewed</Link>}
        </div>
      </section>
      {error && <p role="alert" style={{ color: "#b0413e" }}>{error}</p>}
      <FastQueOrders />
      <section style={card} aria-label="Track orders">
        <h2 style={{ marginTop: 0 }}>Track orders</h2>
        {!orders ? "Loading…" : open.length === 0 ? <p>No open orders.</p> : open.map((o) => <OrderRow key={o.id} o={o} />)}
      </section>
      <section style={card} aria-label="Order history">
        <h2 style={{ marginTop: 0 }}>My orders</h2>
        {!orders ? "Loading…" : past.length === 0 ? <p>No past orders yet.</p> : past.map((o) => <OrderRow key={o.id} o={o} />)}
      </section>
    </main>
  );
}

function OrderRow({ o }: { o: ShopOrderDto }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 0", borderTop: "1px solid var(--bc-border, #e7e0d3)" }}>
      <div>
        <strong>{o.orderNumber}</strong> · {o.salon.name}
        <div style={{ fontSize: "0.85rem", opacity: 0.75 }}>{new Date(o.placedAt).toLocaleString()} · {o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</div>
        <div style={{ fontSize: "0.85rem", fontWeight: 700 }}>{SHOP_ORDER_STATUS_LABEL[o.status]}</div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>{inr(o.total)}</strong>
        <Link href={`/shop/orders/${o.orderNumber}`} style={ghost}>Details</Link>
        {/* Buy again: back to the product, where today's price and stock are shown. */}
        {o.status === "COMPLETED" && o.items[0] && <Link href={`/shop/p/${o.items[0].productId}`} style={btn}>Buy again</Link>}
      </div>
    </div>
  );
}
