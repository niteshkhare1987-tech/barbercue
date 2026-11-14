"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { FAVORITES_PATHS, Role } from "@barbercue/shared";
import { apiFetch } from "./api";
import { useAuth } from "./auth-context";

// One shared favorites state per page: every heart on every salon card reads the same set, so the
// IDs are fetched once (GET favorites/ids), not once per card. Toggles are optimistic and roll back
// if the server refuses. A heart tapped while signed out is remembered for the browser session and
// saved right after the customer signs in.

const PENDING_KEY = "fastque.pendingFavorite";

let ids = new Set<string>();
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => ids;

function setIds(next: Set<string>) {
  ids = next;
  emit();
}

async function loadFor(userId: string) {
  if (loadedFor === userId) return;
  if (loading) return loading;
  loading = apiFetch<{ salonIds: string[] }>(`${FAVORITES_PATHS.favorites}/${FAVORITES_PATHS.ids}`)
    .then((result) => {
      loadedFor = userId;
      setIds(new Set(result.salonIds));
    })
    .catch(() => {
      /* hearts stay neutral; a tap still works and re-syncs */
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function readPending(): string | null {
  try {
    return window.sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}
function writePending(salonId: string | null) {
  try {
    if (salonId) window.sessionStorage.setItem(PENDING_KEY, salonId);
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* private mode: the customer can tap the heart again after signing in */
  }
}

async function setFavorite(salonId: string, favorite: boolean) {
  const before = ids;
  const next = new Set(ids);
  if (favorite) next.add(salonId);
  else next.delete(salonId);
  setIds(next);
  try {
    await apiFetch(`${FAVORITES_PATHS.favorites}/${salonId}`, { method: favorite ? "POST" : "DELETE" });
  } catch (error) {
    setIds(before);
    throw error;
  }
}

/** Test hook: resets the shared state between tests. */
/** Re-read saved salons from the server (e.g. after the Assistant changed them). */
export async function reloadFavoritesFor(userId: string): Promise<void> {
  loadedFor = null;
  await loadFor(userId);
}

export function resetFavoritesForTests() {
  ids = new Set();
  loadedFor = null;
  loading = null;
}

export function useFavorites() {
  const { user, status } = useAuth();
  const router = useRouter();
  const isCustomer = status === "authenticated" && !!user?.roles.includes(Role.CUSTOMER);
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    if (!isCustomer || !user) return;
    void loadFor(user.id).then(() => {
      const pending = readPending();
      if (pending) {
        writePending(null);
        if (!ids.has(pending)) void setFavorite(pending, true).catch(() => {});
      }
    });
  }, [isCustomer, user]);

  const toggle = useCallback(
    async (salonId: string): Promise<"saved" | "removed" | "login"> => {
      if (!isCustomer) {
        writePending(salonId);
        const here = `${window.location.pathname}${window.location.search}`;
        router.push(`/login?next=${encodeURIComponent(here)}`);
        return "login";
      }
      const favorite = !ids.has(salonId);
      await setFavorite(salonId, favorite);
      return favorite ? "saved" : "removed";
    },
    [isCustomer, router],
  );

  return {
    isFavorite: (salonId: string) => current.has(salonId),
    savedIds: current,
    isCustomer,
    toggle,
    ready: status !== "loading",
    // True once this customer's saved IDs have arrived (module state, updated with the same emit).
    loaded: !!user && loadedFor === user.id,
  };
}

export type FavoriteSort = "recent" | "rating" | "name" | "price" | "nearest";

/**
 * Favorites page ordering: most recently saved, highest rated (unrated last), by name, lowest
 * starting price (unpriced last), or nearest (needs `distanceKm`; salons without one go last).
 */
export function sortFavorites<
  T extends { name: string; ratingAverage: number | null; ratingCount: number; favoritedAt: string; priceMin?: number | null; distanceKm?: number | null },
>(items: T[], sort: FavoriteSort): T[] {
  const last = Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) =>
    sort === "rating"
      ? (b.ratingAverage ?? -1) - (a.ratingAverage ?? -1) || b.ratingCount - a.ratingCount
      : sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "price"
          ? (a.priceMin ?? last) - (b.priceMin ?? last) || a.name.localeCompare(b.name)
          : sort === "nearest"
            ? (a.distanceKm ?? last) - (b.distanceKm ?? last) || a.name.localeCompare(b.name)
            : b.favoritedAt.localeCompare(a.favoritedAt),
  );
}
