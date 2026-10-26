"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ADMIN_PATHS, type AdminShopActivityDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../lib/api";
import { Button } from "../ui/Button";
import styles from "../../app/(dashboard)/dashboard/admin/admin.module.css";
import {
  SHOP_ACTIVITY_PRESETS,
  formatRangeLabel,
  presetRange,
  rangeError,
  type ShopActivityPreset,
} from "./shop-activity-range";

/**
 * Shop-wise bookings and live-queue counts for a chosen IST date range. Bookings count by
 * appointment date; queue entries by the day they joined. "Live now" is always the present moment.
 * `search` reuses the admin page's shop search box; `refreshToken` changes when the page's own
 * Refresh button is pressed.
 */
export function ShopActivityPanel({ search = "", refreshToken = 0 }: { search?: string; refreshToken?: number }) {
  const [preset, setPreset] = useState<ShopActivityPreset>("today");
  const [range, setRange] = useState(() => presetRange("today"));
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState<AdminShopActivityDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (from: string, to: string, background = false) => {
    if (!background) setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      const result = await apiFetch<AdminShopActivityDto>(
        `${ADMIN_PATHS.admin}/${ADMIN_PATHS.shopActivity}?${params.toString()}`,
      );
      setData(result);
      setError(null);
    } catch (requestError) {
      // Same rule as the overview poll: a failed background refresh keeps the last good numbers.
      if (!background) {
        setError(requestError instanceof ApiError ? requestError.message : "Could not load shop activity.");
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(range.from, range.to), 0);
    return () => window.clearTimeout(timer);
  }, [load, range, refreshToken]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(range.from, range.to, true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [load, range]);

  function choosePreset(id: Exclude<ShopActivityPreset, "custom">) {
    const next = presetRange(id);
    setPreset(id);
    setRange(next);
    setDraft(next);
  }

  const draftError = preset === "custom" ? rangeError(draft.from, draft.to) : null;
  function applyCustomRange() {
    if (draftError) return;
    setRange({ ...draft });
  }

  const normalizedSearch = search.trim().toLowerCase();
  const shops = useMemo(
    () =>
      (data?.shops ?? []).filter(
        (shop) => !normalizedSearch || `${shop.name} ${shop.publicId}`.toLowerCase().includes(normalizedSearch),
      ),
    [data, normalizedSearch],
  );
  // Only trust numbers that belong to the range on screen; a slow older response is ignored.
  const current = data && data.from === range.from && data.to === range.to ? data : null;

  return (
    <section className={styles.section} aria-labelledby="shop-activity-heading">
      <div className={styles.sectionHeader}>
        <h2 id="shop-activity-heading">Shop activity</h2>
        <span>{formatRangeLabel(range.from, range.to)} · India time</span>
      </div>

      <div className={styles.activityFilters} role="group" aria-label="Date range">
        {SHOP_ACTIVITY_PRESETS.map((option) => (
          <Button
            key={option.id}
            type="button"
            variant={preset === option.id ? "primary" : "outline"}
            aria-pressed={preset === option.id}
            onClick={() => choosePreset(option.id)}
          >
            {option.label}
          </Button>
        ))}
        <Button
          type="button"
          variant={preset === "custom" ? "primary" : "outline"}
          aria-pressed={preset === "custom"}
          onClick={() => setPreset("custom")}
        >
          Custom range
        </Button>
      </div>

      {preset === "custom" && (
        <form
          className={styles.activityCustomRange}
          onSubmit={(event) => {
            event.preventDefault();
            applyCustomRange();
          }}
        >
          <div>
            <label htmlFor="shop-activity-from">From</label>
            <input
              id="shop-activity-from"
              type="date"
              value={draft.from}
              onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="shop-activity-to">To</label>
            <input
              id="shop-activity-to"
              type="date"
              value={draft.to}
              onChange={(event) => setDraft((d) => ({ ...d, to: event.target.value }))}
            />
          </div>
          <Button type="submit" disabled={!!draftError}>Apply</Button>
          {draftError && <p className={styles.activityRangeError} role="alert">{draftError}</p>}
        </form>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      {!current && !error && loading && <p className={styles.loading} role="status">Loading shop activity…</p>}

      {current && (
        <>
          <div className={styles.activityTotals} aria-label="All shops in this period">
            {[
              ["Bookings", current.bookings.total],
              ["Confirmed", current.bookings.confirmed],
              ["Completed", current.bookings.completed],
              ["Cancelled", current.bookings.cancelled],
              ["No-show", current.bookings.noShow],
              ["Queue joined", current.queue.joined],
              ["Served", current.queue.served],
              ["Dropped", current.queue.dropped],
              ["In queue now", current.queue.liveNow],
            ].map(([label, value]) => (
              <article key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </article>
            ))}
          </div>

          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.visuallyHidden}>
                Bookings and live queue per shop, {formatRangeLabel(range.from, range.to)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Shop</th>
                  <th scope="col">Bookings</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">Completed</th>
                  <th scope="col">Cancelled</th>
                  <th scope="col">No-show</th>
                  <th scope="col">Queue joined</th>
                  <th scope="col">Served</th>
                  <th scope="col">Dropped</th>
                  <th scope="col">In queue now</th>
                </tr>
              </thead>
              <tbody>
                {shops.map((shop) => (
                  <tr key={shop.id}>
                    <th scope="row">
                      <strong>{shop.name}</strong>
                      <small>{shop.publicId}</small>
                    </th>
                    <td>{shop.bookings.total}</td>
                    <td>{shop.bookings.confirmed}</td>
                    <td>{shop.bookings.completed}</td>
                    <td>{shop.bookings.cancelled}</td>
                    <td>{shop.bookings.noShow}</td>
                    <td>{shop.queue.joined}</td>
                    <td>{shop.queue.served}</td>
                    <td>{shop.queue.dropped}</td>
                    <td>{shop.queue.liveNow}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shops.length === 0 && (
            <p className={styles.empty}>
              {current.shops.length === 0
                ? "No bookings or queue activity in this period."
                : "No shops with activity match this search."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
