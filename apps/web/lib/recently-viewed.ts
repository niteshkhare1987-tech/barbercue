"use client";

import { RECENTLY_VIEWED_DEFAULT_LIMIT, RECENTLY_VIEWED_PATHS } from "@barbercue/shared";
import { apiFetch } from "./api";

// Recently viewed salons. Signed-in customers: stored on their account (private, cross-device).
// Guests: a small list in this browser only (localStorage), never sent anywhere. Only a real
// salon-detail page visit is recorded — never a card hover or a search impression.

export const GUEST_RECENT_KEY = "fastque.recentSalons";
export const GUEST_RECENT_LIMIT = RECENTLY_VIEWED_DEFAULT_LIMIT;

export interface LocalRecentEntry {
  id: string;
  viewedAt: string;
}

/** Pure: put `id` first (deduplicated) and cap the list. */
export function pushRecent(list: LocalRecentEntry[], id: string, now: Date, limit = GUEST_RECENT_LIMIT): LocalRecentEntry[] {
  return [{ id, viewedAt: now.toISOString() }, ...list.filter((entry) => entry.id !== id)].slice(0, limit);
}

export function parseRecent(raw: string | null): LocalRecentEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is LocalRecentEntry =>
          !!e && typeof e === "object" && typeof (e as LocalRecentEntry).id === "string" && typeof (e as LocalRecentEntry).viewedAt === "string",
      )
      .filter((e) => /^[0-9a-f-]{36}$/i.test(e.id))
      .slice(0, GUEST_RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function readGuestRecent(): LocalRecentEntry[] {
  try {
    return parseRecent(window.localStorage.getItem(GUEST_RECENT_KEY));
  } catch {
    return [];
  }
}

export function writeGuestRecent(list: LocalRecentEntry[]) {
  try {
    if (list.length === 0) window.localStorage.removeItem(GUEST_RECENT_KEY);
    else window.localStorage.setItem(GUEST_RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked (private mode): history simply isn't kept */
  }
}

export async function recordSalonView(salonId: string, signedInCustomer: boolean): Promise<void> {
  if (signedInCustomer) {
    await apiFetch(`${RECENTLY_VIEWED_PATHS.recentlyViewed}/${salonId}`, { method: "POST" }).catch(() => undefined);
    return;
  }
  writeGuestRecent(pushRecent(readGuestRecent(), salonId, new Date()));
}

export async function removeRecent(salonId: string, signedInCustomer: boolean): Promise<void> {
  if (signedInCustomer) {
    await apiFetch(`${RECENTLY_VIEWED_PATHS.recentlyViewed}/${salonId}`, { method: "DELETE" });
    return;
  }
  writeGuestRecent(readGuestRecent().filter((e) => e.id !== salonId));
}

export async function clearRecent(signedInCustomer: boolean): Promise<void> {
  if (signedInCustomer) {
    await apiFetch(RECENTLY_VIEWED_PATHS.recentlyViewed, { method: "DELETE" });
  }
  writeGuestRecent([]);
}

/** "Just now", "2 hours ago", "Yesterday", "3 days ago", or a date. */
export function lastViewedLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && then.getDate() === now.getDate()) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.ceil((startToday - then.getTime()) / 86_400_000);
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
