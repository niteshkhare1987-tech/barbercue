"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  EMPLOYEE_PATHS,
  ONBOARDING_BUCKET_LABELS,
  ONBOARDING_STATUS_LABELS,
  type OnboardingBucket,
  type OnboardingCountsDto,
  type OnboardingFunnelDto,
  type OnboardingListItemDto,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../lib/api";
import { EMPLOYEE_ONBOARDING } from "../../lib/onboarding";
import base from "../../app/employee/employee.module.css";
import styles from "../../app/employee/onboarding/onboarding.module.css";

const BUCKETS = Object.keys(ONBOARDING_BUCKET_LABELS) as OnboardingBucket[];

export function EmployeeOnboardingTab() {
  const [bucket, setBucket] = useState<OnboardingBucket>("drafts");
  const [counts, setCounts] = useState<OnboardingCountsDto | null>(null);
  const [items, setItems] = useState<OnboardingListItemDto[]>([]);
  const [funnel, setFunnel] = useState<OnboardingFunnelDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Items are shown only once they belong to the selected bucket, so switching tabs shows
  // "Loading…" without resetting state inside the effect.
  const [loadedBucket, setLoadedBucket] = useState<OnboardingBucket | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<OnboardingCountsDto>(`${EMPLOYEE_ONBOARDING}/${EMPLOYEE_PATHS.counts}`),
      apiFetch<OnboardingListItemDto[]>(`${EMPLOYEE_ONBOARDING}?bucket=${bucket}`),
    ])
      .then(([nextCounts, nextItems]) => {
        if (cancelled) return;
        setCounts(nextCounts);
        setItems(nextItems);
        setLoadedBucket(bucket);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load onboarding applications.");
        setItems([]);
        setLoadedBucket(bucket);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket]);

  useEffect(() => {
    apiFetch<OnboardingFunnelDto>(`${EMPLOYEE_ONBOARDING}/${EMPLOYEE_PATHS.analytics}`)
      .then(setFunnel)
      .catch(() => setFunnel(null));
  }, []);

  return (
    <>
      <section className={base.panel}>
        <div className={base.sectionHeader}>
          <h2>Salon Onboarding</h2>
          <Link className={base.primaryButton} href="/employee/onboarding/new">
            + New onboarding
          </Link>
        </div>
        <nav className={`${base.tabs} ${styles.categoryTabs}`} aria-label="Onboarding categories">
          {BUCKETS.map((b) => (
            <button key={b} type="button" className={bucket === b ? base.tabActive : base.tab} onClick={() => setBucket(b)}>
              {ONBOARDING_BUCKET_LABELS[b]}
              <span className={styles.count}>{counts ? counts[b] : "…"}</span>
            </button>
          ))}
        </nav>
        {error && <p className={base.error} role="alert">{error}</p>}
        {loadedBucket !== bucket && <p className={base.empty} aria-busy="true">Loading…</p>}
        {loadedBucket === bucket && items.length === 0 && !error && (
          <p className={base.empty}>
            {bucket === "drafts"
              ? "No drafts. Start a new onboarding, or use “Start onboarding” on a lead."
              : `Nothing in ${ONBOARDING_BUCKET_LABELS[bucket]}.`}
          </p>
        )}
        <div className={styles.bucketList}>
          {loadedBucket === bucket && items.map((item) => (
            <Link key={item.id} className={styles.bucketRow} href={`/employee/onboarding/${item.id}`}>
              <div>
                <strong>{item.salonName}</strong>
                <small>
                  <span className={styles.ref}>{item.reference}</span> · {[item.locality, item.city].filter(Boolean).join(", ") || "No address yet"}
                  {item.employee.fullName ? ` · ${item.employee.fullName}` : ""}
                </small>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className={item.status === "CHANGES_REQUESTED" || item.status === "REJECTED" ? styles.badgeWarn : styles.badge}>
                  {ONBOARDING_STATUS_LABELS[item.status]}
                </span>
                <small>
                  {item.serviceCount} services · {item.photoCount} photos
                  {item.missingCount > 0 && ["DRAFT", "CHANGES_REQUESTED"].includes(item.status) ? ` · ${item.missingCount} to complete` : ""}
                </small>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {funnel && (
        <section className={base.panel} aria-label="Your onboarding performance">
          <div className={base.sectionHeader}>
            <h2>Your onboarding funnel</h2>
            <span>Only admin-approved salons count as onboarded</span>
          </div>
          <div className={styles.funnel}>
            <article><strong>{funnel.visits}</strong><span>Salons visited</span></article>
            <article><strong>{funnel.leadsCreated}</strong><span>Leads created</span></article>
            <article><strong>{funnel.applicationsStarted}</strong><span>Applications started</span></article>
            <article><strong>{funnel.applicationsSubmitted}</strong><span>Submitted</span></article>
            <article><strong>{funnel.approved}</strong><span>Admin-approved</span></article>
            <article><strong>{funnel.rejected}</strong><span>Rejected</span></article>
            <article><strong>{funnel.ownerActivated}</strong><span>Owner activated</span></article>
            <article><strong>{funnel.publiclyActive}</strong><span>Live on FastQue</span></article>
            <article><strong>{funnel.receivingBookings}</strong><span>Receiving bookings</span></article>
            <article><strong>{funnel.pendingCorrections}</strong><span>Pending corrections</span></article>
            <article><strong>{funnel.avgDaysSubmissionToApproval ?? "—"}</strong><span>Avg days to approval</span></article>
            <article><strong>{funnel.avgDaysApprovalToActivation ?? "—"}</strong><span>Avg days to activation</span></article>
            <article><strong>{funnel.conversionRate === null ? "—" : `${funnel.conversionRate}%`}</strong><span>Submitted → approved</span></article>
          </div>
        </section>
      )}
    </>
  );
}
