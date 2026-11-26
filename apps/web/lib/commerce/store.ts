"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { CommerceConfigDto, CommerceProductDto } from "@barbercue/shared";
import { apiFetch } from "../api";

// FastQue Direct Commerce on this device: whether it is switched on (asked from the server once), the
// FastQue bag, saved-for-later, the delivery PIN and guest order links. Prices and stock are always
// re-read from the server before ordering. The salon bag (lib/shop/store) is a separate store.

export interface FqLine {
  listingId: string;
  productId: string;
  name: string;
  brand: string | null;
  variant: string | null;
  category: string | null;
  imageUrl: string | null;
  price: string;
  quantity: number;
}
export interface FqOrderLink {
  orderNumber: string;
  token: string;
  placedAt: string;
}

const OFF: CommerceConfigDto = { enabled: false, multiSellerCart: false, cod: false, delivery: false, returns: false, insights: false, seller: null };
let pending: Promise<CommerceConfigDto> | null = null;

/** Off until the server says otherwise; a failed request also means off. */
export function useCommerceConfig(): CommerceConfigDto {
  const [cfg, setCfg] = useState(OFF);
  useEffect(() => {
    let live = true;
    pending ??= apiFetch<CommerceConfigDto>("commerce/config").catch(() => {
      pending = null;
      return OFF;
    });
    void pending.then((c) => live && setCfg(c?.enabled ? c : OFF));
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

const KEYS = { bag: "fq.dc.bag.v1", saved: "fq.dc.saved.v1", pin: "fq.dc.pin.v1", orders: "fq.dc.orders.v1", viewed: "fq.dc.viewed.v1" } as const;
type Key = keyof typeof KEYS;
const listeners = new Set<() => void>();
const cache = new Map<Key, { raw: string | null; value: unknown }>();

function read<T>(key: Key, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEYS[key]);
  } catch {
    raw = cache.get(key)?.raw ?? null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  let value = fallback;
  try {
    if (raw) value = JSON.parse(raw) as T;
  } catch {
    value = fallback;
  }
  cache.set(key, { raw, value });
  return value;
}
function write<T>(key: Key, value: T) {
  const raw = JSON.stringify(value);
  try {
    window.localStorage.setItem(KEYS[key], raw);
  } catch {
    cache.set(key, { raw, value });
  }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener("storage", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", l);
  };
}
const NONE: never[] = [];
function useStored<T>(key: Key, fallback: T): T {
  return useSyncExternalStore(subscribe, () => read(key, fallback), () => fallback);
}
export const useFqBag = () => useStored<FqLine[]>("bag", NONE);
export const useFqSaved = () => useStored<FqLine[]>("saved", NONE);
export const useFqPin = () => useStored<string>("pin", "");
export const useFqViewed = () => useStored<string[]>("viewed", NONE);
export const useFqOrders = () => useStored<FqOrderLink[]>("orders", NONE);

export const lineOf = (p: CommerceProductDto, quantity = 1): FqLine => ({
  listingId: p.listingId,
  productId: p.productId,
  name: p.name,
  brand: p.brand,
  variant: p.variant,
  category: p.category,
  imageUrl: p.imageUrl,
  price: p.price,
  quantity,
});

export const fqBag = {
  add(line: FqLine) {
    const cur = read<FqLine[]>("bag", NONE);
    write(
      "bag",
      cur.some((l) => l.listingId === line.listingId)
        ? cur.map((l) => (l.listingId === line.listingId ? { ...l, quantity: Math.min(50, l.quantity + line.quantity) } : l))
        : [...cur, line].slice(0, 20),
    );
  },
  setQuantity(id: string, quantity: number) {
    const cur = read<FqLine[]>("bag", NONE);
    write("bag", quantity <= 0 ? cur.filter((l) => l.listingId !== id) : cur.map((l) => (l.listingId === id ? { ...l, quantity: Math.min(50, quantity) } : l)));
  },
  remove(id: string) {
    write("bag", read<FqLine[]>("bag", NONE).filter((l) => l.listingId !== id));
  },
  saveForLater(line: FqLine) {
    fqBag.remove(line.listingId);
    write("saved", [line, ...read<FqLine[]>("saved", NONE).filter((l) => l.listingId !== line.listingId)].slice(0, 50));
  },
  moveToBag(line: FqLine) {
    write("saved", read<FqLine[]>("saved", NONE).filter((l) => l.listingId !== line.listingId));
    fqBag.add(line);
  },
  /** Adds lines saved on the account that this device does not have yet. */
  merge(lines: FqLine[]) {
    const cur = read<FqLine[]>("bag", NONE);
    const extra = lines.filter((l) => !cur.some((x) => x.listingId === l.listingId));
    if (extra.length) write("bag", [...cur, ...extra].slice(0, 20));
  },
  clear() {
    write("bag", []);
  },
};
export function rememberViewed(listingId: string) {
  write("viewed", [listingId, ...read<string[]>("viewed", NONE).filter((x) => x !== listingId)].slice(0, 12));
}
export const setFqPin = (pin: string) => write("pin", pin);
export function rememberFqOrder(o: FqOrderLink) {
  write("orders", [o, ...read<FqOrderLink[]>("orders", NONE).filter((x) => x.orderNumber !== o.orderNumber)].slice(0, 20));
}
