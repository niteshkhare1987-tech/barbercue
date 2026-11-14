"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BOOKING_PATHS,
  DATE_RANGE_PRESETS,
  REVIEW_PATHS,
  presetRange,
  type BookingDetailDto,
  type CustomerReviewDto,
  type DateRangePreset,
  type PaginatedResult,
  type ReviewDetailDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../../lib/api";
import { DashIcon } from "../../../../components/customer-dashboard/icons";
import styles from "../../../../components/customer-dashboard/dash.module.css";

function Stars({ rating }: { rating: number }) {
  return (
    <span aria-label={`${rating} out of 5 stars`} style={{ color: "#f5a623", letterSpacing: 1 }}>
      {"★★★★★".slice(0, rating)}
      <span style={{ color: "var(--bc-border)" }}>{"★★★★★".slice(rating)}</span>
    </span>
  );
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * My Reviews: only the signed-in customer's own reviews (GET reviews/mine is scoped server-side).
 * One review per completed booking is enforced by the API; edits use the existing PATCH route.
 * There is no customer delete in the review policy, so removal is a request to support.
 */
export default function MyReviewsPage() {
  const [items, setItems] = useState<CustomerReviewDto[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toReview, setToReview] = useState<BookingDetailDto[]>([]);
  const [range, setRange] = useState<DateRangePreset | "">("");
  const [rating, setRating] = useState<number | 0>(0);
  const [salon, setSalon] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback((after?: string) => {
    return apiFetch<PaginatedResult<CustomerReviewDto>>(`${REVIEW_PATHS.reviews}/${REVIEW_PATHS.mine}${after ? `?cursor=${after}` : ""}`)
      .then((page) => {
        setItems((cur) => (after && cur ? [...cur, ...page.items] : page.items));
        setCursor(page.nextCursor);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn’t load your reviews."));
  }, []);

  useEffect(() => {
    void load();
    apiFetch<PaginatedResult<BookingDetailDto>>(`${BOOKING_PATHS.bookings}/${BOOKING_PATHS.mine}?status=COMPLETED`)
      .then((page) => setToReview(page.items.filter((b) => !b.hasReview)))
      .catch(() => undefined);
  }, [load]);

  const salons = useMemo(() => [...new Map((items ?? []).map((r) => [r.salonId, r.salonName])).entries()], [items]);
  const shown = useMemo(() => {
    let list = items ?? [];
    if (range) {
      const { from, to } = presetRange(range);
      list = list.filter((r) => {
        const d = r.createdAt.slice(0, 10);
        return d >= from && d <= to;
      });
    }
    if (rating) list = list.filter((r) => r.rating === rating);
    if (salon) list = list.filter((r) => r.salonId === salon);
    return list;
  }, [items, range, rating, salon]);

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>My Reviews</h1>
          <p className={styles.sub}>Reviews you’ve left after your visits, and any replies from the salon.</p>
        </div>
      </div>

      {toReview.length > 0 && (
        <section className={styles.card} aria-labelledby="to-review">
          <h2 id="to-review" className={styles.sectionTitle}>Waiting for your review</h2>
          <div className={styles.list} style={{ marginTop: 12 }}>
            {toReview.slice(0, 3).map((b) => (
              <div key={b.id} className={styles.cardHead} style={{ marginBottom: 0 }}>
                <span>
                  <strong>{b.salonName}</strong>
                  <span className={styles.meta}> · {b.serviceName} · {day(b.slotStart)}</span>
                </span>
                <Link href={`/account/bookings?tab=completed#booking-${b.id}`} className={styles.btn}>Write a review</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className={styles.filters} aria-label="Filter reviews">
        <label className={styles.field}>
          Date
          <select value={range} onChange={(e) => setRange(e.target.value as DateRangePreset | "")}>
            <option value="">Any time</option>
            {DATE_RANGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Rating
          <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
            <option value={0}>All ratings</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n === 1 ? "" : "s"}</option>)}
          </select>
        </label>
        <label className={styles.field}>
          Salon
          <select value={salon} onChange={(e) => setSalon(e.target.value)}>
            <option value="">All salons</option>
            {salons.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {items === null && !error && (
        <div className={styles.list} aria-busy="true">{[0, 1].map((i) => <div key={i} className={styles.skeleton} style={{ height: 110 }} />)}</div>
      )}
      {items && shown.length === 0 && (
        <div className={styles.empty}>
          <span className={styles.emptyIcon}><DashIcon name="star" size={26} /></span>
          <h2>{items.length ? "No reviews match these filters" : "Your reviews will appear here after your visits."}</h2>
          <p>{items.length ? "Try clearing a filter." : "After a completed appointment you can rate the salon from My Appointments."}</p>
        </div>
      )}

      <div className={styles.list}>
        {shown.map((review) => (
          <article key={review.id} className={styles.card}>
            <div className={styles.cardHead} style={{ alignItems: "start" }}>
              <div className={styles.rowMain}>
                <h2 className={styles.rowTitle}>
                  <Link href={`/${review.countryCode.toLowerCase()}/${review.citySlug}/${review.salonSlug}`}>{review.salonName}</Link>
                </h2>
                <p className={styles.meta}>{review.serviceName} · Visit on {day(review.visitDate)}</p>
              </div>
              <span className={`${styles.badge} ${styles.badgeGreen}`}>Published</span>
            </div>
            {editing === review.id ? (
              <EditReview
                review={review}
                onCancel={() => setEditing(null)}
                onSaved={(updated) => {
                  setItems((cur) => cur?.map((r) => (r.id === review.id ? { ...r, rating: updated.rating, comment: updated.comment, updatedAt: updated.updatedAt } : r)) ?? null);
                  setEditing(null);
                }}
              />
            ) : (
              <>
                <Stars rating={review.rating} />
                {review.comment && <p style={{ margin: "8px 0 0" }}>{review.comment}</p>}
                <p className={styles.meta} style={{ marginTop: 6 }}>
                  Reviewed {day(review.createdAt)}{review.updatedAt !== review.createdAt ? ` · edited ${day(review.updatedAt)}` : ""}
                </p>
                {review.ownerResponse && (
                  <p className={styles.notice} style={{ marginTop: 10 }}><strong>Salon’s reply:</strong> {review.ownerResponse}</p>
                )}
                <div className={styles.actions} style={{ marginTop: 10 }}>
                  <button type="button" className={styles.btn} onClick={() => setEditing(review.id)}>Edit review</button>
                  <Link href="/contact-us" className={styles.btnGhost}>Request removal</Link>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
      {cursor && <div><button type="button" className={styles.btn} onClick={() => void load(cursor)}>Load more</button></div>}
    </div>
  );
}

function EditReview({ review, onCancel, onSaved }: { review: CustomerReviewDto; onCancel: () => void; onSaved: (r: ReviewDetailDto) => void }) {
  const [rating, setRating] = useState(review.rating);
  const [comment, setComment] = useState(review.comment ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await apiFetch<ReviewDetailDto>(`${REVIEW_PATHS.reviews}/${review.id}`, {
        method: "PATCH",
        body: JSON.stringify({ rating, comment: comment.trim() }),
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn’t save your review.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className={styles.chips} role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} className={styles.chip} onClick={() => setRating(n)}>
            {n} ★
          </button>
        ))}
      </div>
      <label className={styles.field}>
        Your review
        <textarea
          value={comment}
          maxLength={1000}
          rows={3}
          onChange={(e) => setComment(e.target.value)}
          style={{ padding: 10, borderRadius: 10, border: "1px solid var(--bc-border)", font: "inherit", color: "var(--bc-ink)" }}
        />
      </label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.btnPrimary} onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save review"}</button>
        <button type="button" className={styles.btn} onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}
