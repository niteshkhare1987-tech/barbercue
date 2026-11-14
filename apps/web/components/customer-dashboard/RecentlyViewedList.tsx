"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RECENTLY_VIEWED_PATHS, formatMoney, type RecentSalonDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { clearRecent, lastViewedLabel, readGuestRecent, removeRecent, writeGuestRecent } from "../../lib/recently-viewed";
import { FavoriteButton } from "../discovery/FavoriteButton";
import { SalonImage } from "../ui/SalonImage";
import { ShareSalonButton } from "./ShareSalonButton";
import { DashIcon } from "./icons";
import styles from "./dash.module.css";

/**
 * The signed-in customer's recently viewed salons (account history, newest first). If this browser
 * also holds history from browsing while signed out, the customer may choose to add it — nothing is
 * copied to the account without that tap.
 */
export function RecentlyViewedList({ limit, compact = false }: { limit?: number; compact?: boolean }) {
  const [items, setItems] = useState<RecentSalonDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localCount, setLocalCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    apiFetch<RecentSalonDto[]>(RECENTLY_VIEWED_PATHS.recentlyViewed)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn’t load your recently viewed salons."));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      load();
      setLocalCount(readGuestRecent().length);
    });
  }, [load]);

  async function importLocal() {
    setBusy(true);
    const local = readGuestRecent();
    // Oldest first so the most recent ends up on top of the account history.
    for (const entry of [...local].reverse()) {
      await apiFetch(`${RECENTLY_VIEWED_PATHS.recentlyViewed}/${entry.id}`, { method: "POST" }).catch(() => undefined);
    }
    writeGuestRecent([]);
    setLocalCount(0);
    setBusy(false);
    load();
  }

  async function remove(id: string) {
    const before = items;
    setItems((cur) => cur?.filter((s) => s.id !== id) ?? null);
    try {
      await removeRecent(id, true);
    } catch {
      setItems(before);
      setError("Couldn’t remove that salon. Try again.");
    }
  }

  async function clearAll() {
    if (!window.confirm("Clear your recently viewed salons? This can’t be undone.")) return;
    const before = items;
    setItems([]);
    try {
      await clearRecent(true);
    } catch {
      setItems(before);
      setError("Couldn’t clear your history. Try again.");
    }
  }

  const shown = limit ? items?.slice(0, limit) : items;

  return (
    <div className={styles.list}>
      {localCount > 0 && !compact && (
        <div className={styles.notice}>
          You viewed {localCount} {localCount === 1 ? "salon" : "salons"} on this device while signed out.{" "}
          <button type="button" className={styles.btnGhost} onClick={() => void importLocal()} disabled={busy}>
            {busy ? "Adding…" : "Add to my account"}
          </button>
          <button type="button" className={styles.btnGhost} onClick={() => { writeGuestRecent([]); setLocalCount(0); }}>
            Discard
          </button>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {items === null && !error && (
        <div className={styles.list} aria-busy="true" aria-label="Loading recently viewed">
          {[0, 1].map((i) => <div key={i} className={styles.skeleton} style={{ height: 92 }} />)}
        </div>
      )}
      {items && items.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><DashIcon name="history" size={26} /></span>
          <h3>No recently viewed salons</h3>
          <p>Salons you open will appear here so you can get back to them quickly.</p>
          <Link href="/account/discover" className={styles.btnPrimary}>Explore Salons</Link>
        </div>
      )}
      {shown?.map((salon) => {
        const href = `/${salon.countryCode.toLowerCase()}/${salon.citySlug}/${salon.slug}`;
        const query = new URLSearchParams({ city: salon.citySlug, country: salon.countryCode }).toString();
        return (
          <article key={salon.id} className={styles.row}>
            <div className={styles.thumb}><SalonImage url={salon.coverPhotoUrl} alt="" aspectRatio="1 / 1" rounded={0} /></div>
            <div className={styles.rowMain}>
              <h3 className={styles.rowTitle}><Link href={href}>{salon.name}</Link></h3>
              <p className={styles.meta}>
                Last viewed: {lastViewedLabel(salon.viewedAt)}
                {salon.ratingAverage !== null ? ` · ★ ${salon.ratingAverage.toFixed(1)} (${salon.ratingCount})` : " · New on FastQue"}
              </p>
              <p className={styles.meta}>{salon.addressLine}</p>
              {salon.priceMin !== null && <p className={styles.meta}>From {formatMoney(salon.priceMin, salon.currency, salon.countryCode)}</p>}
              {!compact && (
                <div className={styles.actions} style={{ marginTop: 6 }}>
                  <Link href={href} className={styles.btn}>View Salon</Link>
                  {!salon.isClosedForToday && <Link href={`/book/${salon.slug}?${query}`} className={styles.btnPrimary}>Book</Link>}
                </div>
              )}
            </div>
            <div className={styles.actions}>
              <FavoriteButton salonId={salon.id} salonName={salon.name} variant="inline" />
              {!compact && <ShareSalonButton salon={salon} variant="inline" />}
              {!compact && (
                <button type="button" className={styles.btnGhost} onClick={() => void remove(salon.id)} aria-label={`Remove ${salon.name} from recently viewed`}>
                  Remove
                </button>
              )}
            </div>
          </article>
        );
      })}
      {!compact && items && items.length > 0 && (
        <div>
          <button type="button" className={styles.btnGhost} onClick={() => void clearAll()}>Clear history</button>
        </div>
      )}
    </div>
  );
}
