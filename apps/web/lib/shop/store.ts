"use client";

import { useSyncExternalStore } from "react";

// Marketplace device storage: the bag, the guest wishlist, recently viewed products, the shopper's
// chosen location and the guest's order links. Only ids and quantities are kept — prices, stock and
// availability are always re-read from the server (POST shop/cart/quote) before checkout.

export interface BagLine {
  listingId: string;
  productId: string;
  salonId: string;
  salonName: string;
  name: string;
  brand: string | null;
  variant: string | null;
  category: string | null;
  quantity: number;
  /** Price when added — display only; the server price wins at checkout. */
  price: string;
}
/** Either the device's position (distance-sorted sellers) or a chosen city (sellers in that city). */
export interface ShopLocation {
  lat?: number;
  lng?: number;
  citySlug?: string;
  label: string;
}
export interface GuestOrderLink {
  orderNumber: string;
  token: string;
  placedAt: string;
}

const KEYS = { bag: "fq.shop.bag.v1", wish: "fq.shop.wish.v1", recent: "fq.shop.recent.v1", loc: "fq.shop.loc.v1", orders: "fq.shop.orders.v1" } as const;
type Key = keyof typeof KEYS;

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function read<T>(key: Key, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEYS[key]);
  } catch {
    raw = null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value: T = fallback;
  try {
    value = raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    value = fallback;
  }
  cache.set(key, { raw, value });
  return value;
}
function write<T>(key: Key, value: T) {
  try {
    window.localStorage.setItem(KEYS[key], JSON.stringify(value));
  } catch {
    /* private mode / storage full: the bag still works for this page view */
    cache.set(key, { raw: JSON.stringify(value), value });
  }
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = () => listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
const EMPTY: never[] = [];
function useStored<T>(key: Key, fallback: T): T {
  return useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback);
}

export const useBag = () => useStored<BagLine[]>("bag", EMPTY);
export const useWishlist = () => useStored<string[]>("wish", EMPTY);
export const useRecent = () => useStored<string[]>("recent", EMPTY);
export const useShopLocation = () => useStored<ShopLocation | null>("loc", null);
export const useGuestOrders = () => useStored<GuestOrderLink[]>("orders", EMPTY);

export const bagCount = (bag: BagLine[]) => bag.reduce((n, l) => n + l.quantity, 0);

export const bag = {
  get: () => read<BagLine[]>("bag", []),
  /** Adds a line. Returns false (and changes nothing) if the bag holds another salon's products. */
  add(line: BagLine): "added" | "other-salon" {
    const current = read<BagLine[]>("bag", []);
    if (current.length && current.some((l) => l.salonId !== line.salonId)) return "other-salon";
    const existing = current.find((l) => l.listingId === line.listingId);
    write("bag", existing ? current.map((l) => (l.listingId === line.listingId ? { ...l, quantity: Math.min(50, l.quantity + line.quantity) } : l)) : [...current, line]);
    return "added";
  },
  /** Adds a line whatever salon it is from. Only used when the server allows a multi-seller bag. */
  addAny(line: BagLine): "added" | "other-salon" {
    const current = read<BagLine[]>("bag", []);
    write(
      "bag",
      current.some((l) => l.listingId === line.listingId)
        ? current.map((l) => (l.listingId === line.listingId ? { ...l, quantity: Math.min(50, l.quantity + line.quantity) } : l))
        : [...current, line],
    );
    return "added";
  },
  replaceWith(line: BagLine) {
    write("bag", [line]);
  },
  setQuantity(listingId: string, quantity: number) {
    const current = read<BagLine[]>("bag", []);
    write("bag", quantity <= 0 ? current.filter((l) => l.listingId !== listingId) : current.map((l) => (l.listingId === listingId ? { ...l, quantity: Math.min(50, quantity) } : l)));
  },
  remove(listingId: string) {
    write("bag", read<BagLine[]>("bag", []).filter((l) => l.listingId !== listingId));
  },
  clear() {
    write("bag", []);
  },
};

export const wishlist = {
  toggle(productId: string): boolean {
    const current = read<string[]>("wish", []);
    const on = !current.includes(productId);
    write("wish", on ? [productId, ...current].slice(0, 200) : current.filter((id) => id !== productId));
    return on;
  },
  set(ids: string[]) {
    write("wish", ids.slice(0, 200));
  },
};

export function rememberViewed(productId: string) {
  const current = read<string[]>("recent", []);
  write("recent", [productId, ...current.filter((id) => id !== productId)].slice(0, 12));
}

export function setShopLocation(loc: ShopLocation | null) {
  write("loc", loc);
}

export function rememberGuestOrder(link: GuestOrderLink) {
  const current = read<GuestOrderLink[]>("orders", []);
  write("orders", [link, ...current.filter((o) => o.orderNumber !== link.orderNumber)].slice(0, 20));
}

/** "?lat=..&lng=.." for API calls when the shopper shared a location. */
export const locationQuery = (loc: ShopLocation | null) =>
  !loc ? "" : loc.lat != null && loc.lng != null ? `lat=${loc.lat.toFixed(4)}&lng=${loc.lng.toFixed(4)}` : loc.citySlug ? `city=${encodeURIComponent(loc.citySlug)}` : "";

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `shop-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
