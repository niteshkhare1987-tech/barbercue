"use client";

import { useSyncExternalStore } from "react";

// Device-level customer preferences for the dashboard. The account has no server-side preferred
// city field yet, so this is stored in this browser only (and said so in Settings). Nothing here is
// precise location: a city choice is a slug/name, and GPS is only read when the customer taps
// "Use my current location", per request, never continuously.

const KEY = "fastque.customerPrefs";

export interface PreferredCity {
  slug: string;
  name: string;
  countryCode: string;
}

export interface CustomerPrefs {
  preferredCity: PreferredCity | null;
}

const EMPTY: CustomerPrefs = { preferredCity: null };
let cache: CustomerPrefs | null = null;
const listeners = new Set<() => void>();

export function parsePrefs(raw: string | null): CustomerPrefs {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<CustomerPrefs>;
    const city = value.preferredCity;
    const valid =
      city &&
      typeof city.slug === "string" &&
      /^[a-z0-9-]{1,80}$/.test(city.slug) &&
      typeof city.name === "string" &&
      typeof city.countryCode === "string" &&
      /^[A-Z]{2}$/.test(city.countryCode);
    return { preferredCity: valid ? { slug: city.slug, name: city.name.slice(0, 80), countryCode: city.countryCode } : null };
  } catch {
    return EMPTY;
  }
}

function read(): CustomerPrefs {
  if (cache) return cache;
  try {
    cache = parsePrefs(window.localStorage.getItem(KEY));
  } catch {
    cache = EMPTY;
  }
  return cache;
}

export function savePrefs(next: CustomerPrefs) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: preference lasts for this page only */
  }
  for (const listener of listeners) listener();
}

export function useCustomerPrefs(): CustomerPrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => EMPTY,
  );
}
