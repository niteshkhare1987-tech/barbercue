"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FAVORITES_PATHS, straightLineKm, type FavoriteSalonDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../../lib/api";
import { useAssistantRefresh } from "../../../../lib/assistant-events";
import { reloadFavoritesFor, sortFavorites, useFavorites, type FavoriteSort } from "../../../../lib/favorites";
import { useAuth } from "../../../../lib/auth-context";
import { SalonCard } from "../../../../components/discovery/SalonCard";
import { DashIcon } from "../../../../components/customer-dashboard/icons";
import dash from "../../../../components/customer-dashboard/dash.module.css";
import styles from "./favorites.module.css";

/** The customer's saved salons, each with Book / Join queue, share, and the heart to remove it. */
export default function FavoritesPage() {
  const [items, setItems] = useState<FavoriteSalonDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<FavoriteSort>("recent");
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const { isFavorite, loaded } = useFavorites();
  const { user } = useAuth();
  // Saved or removed through the Assistant: reload the list and the shared hearts from the server.
  useAssistantRefresh("favorites", () => {
    if (user) void reloadFavoritesFor(user.id);
    apiFetch<FavoriteSalonDto[]>(FAVORITES_PATHS.favorites).then(setItems).catch(() => undefined);
  });

  useEffect(() => {
    apiFetch<FavoriteSalonDto[]>(FAVORITES_PATHS.favorites)
      .then(setItems)
      .catch((requestError) => setError(requestError instanceof ApiError ? requestError.message : "Couldn’t load your favorites."));
  }, []);

  // "Nearest first" asks for the device location once, on request. Distances are straight-line.
  function chooseSort(next: FavoriteSort) {
    setSort(next);
    if (next !== "nearest" || origin) return;
    if (!navigator.geolocation) {
      setLocationNote("Location isn’t available in this browser.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLocationNote(null);
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setLocationNote("Location wasn’t shared, so salons can’t be ordered by distance.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  // A heart tapped on this page removes the salon straight away (shared optimistic store).
  // Until the shared heart state has loaded, show everything (no flash of an empty list).
  const shown = useMemo(() => {
    const withDistance = (items ?? []).map((item) =>
      origin && item.lat !== null && item.lng !== null
        ? { ...item, distanceKm: Math.round(straightLineKm(origin, { lat: item.lat, lng: item.lng }) * 10) / 10 }
        : item,
    );
    return sortFavorites(withDistance.filter((item) => !loaded || isFavorite(item.id)), sort);
  }, [items, sort, isFavorite, loaded, origin]);

  return (
    <section className={dash.page} aria-labelledby="favorites-title">
      <div className={dash.pageHead}>
        <div>
          <h1 id="favorites-title" className={dash.title}>My Favourites</h1>
          <p className={dash.sub}>Salons you saved with the heart. Book again in one tap.</p>
        </div>
        {items && items.length > 1 && (
          <label className={dash.field}>
            Sort by
            <select value={sort} onChange={(e) => chooseSort(e.target.value as FavoriteSort)} disabled={locating}>
              <option value="recent">Recently saved</option>
              <option value="nearest">Nearest first</option>
              <option value="rating">Highest rated</option>
              <option value="price">Lowest starting price</option>
              <option value="name">Name</option>
            </select>
          </label>
        )}
      </div>

      {sort === "nearest" && origin && <p className={dash.meta}>Distances are straight-line from your current location, not driving distance.</p>}
      {locating && <p className={dash.meta} role="status">Getting your location…</p>}
      {locationNote && <p className={dash.notice} role="status">{locationNote}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!items && !error && <div className={styles.grid} aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className={dash.skeleton} style={{ height: 300 }} />)}</div>}

      {items && shown.length === 0 && (
        <div className={dash.empty}>
          <span className={dash.emptyIcon}><DashIcon name="heart" size={26} /></span>
          <h2>Save salons you love for faster booking next time.</h2>
          <p>Tap the heart on any salon and it will appear here, on every device you sign in to.</p>
          <Link href="/account/discover" className={dash.btnPrimary}>Explore Salons</Link>
        </div>
      )}

      {shown.length > 0 && (
        <div className={styles.grid}>
          {shown.map((salon) => (
            <SalonCard key={salon.id} salon={salon} />
          ))}
        </div>
      )}
      <p className={dash.meta}>
        Looking for somewhere you opened recently? <Link href="/account/discover?tab=recent">Recently viewed salons</Link>
      </p>
    </section>
  );
}
