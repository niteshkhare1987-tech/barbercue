"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ADMIN_PATHS,
  ONBOARDING_STATUS_LABELS,
  OnboardingStatus,
  type AdminOnboardingAnalyticsDto,
  type AdminOnboardingKpisDto,
  type AdminOnboardingListDto,
} from "@barbercue/shared";
import { ApiError, apiFetch } from "../../../../../lib/api";
import { ADMIN_ONBOARDING } from "../../../../../lib/onboarding";
import { LinkButton } from "../../../../../components/ui/Button";
import styles from "../admin.module.css";
import local from "./onboarding-admin.module.css";

const EMPTY_FILTERS = {
  q: "",
  status: "",
  city: "",
  territory: "",
  employeeId: "",
  reviewerId: "",
  from: "",
  to: "",
  missingInfo: "",
};

function when(value: string | null): string {
  return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

export default function AdminOnboardingQueuePage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<AdminOnboardingListDto | null>(null);
  const [kpis, setKpis] = useState<AdminOnboardingKpisDto | null>(null);
  const [analytics, setAnalytics] = useState<AdminOnboardingAnalyticsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    params.set("page", String(page));
    params.set("pageSize", "25");
    return params.toString();
  }, [filters, page]);

  const load = useCallback(async () => {
    try {
      setList(await apiFetch<AdminOnboardingListDto>(`${ADMIN_ONBOARDING}?${query}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load onboarding applications.");
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    apiFetch<AdminOnboardingKpisDto>(`${ADMIN_ONBOARDING}/${ADMIN_PATHS.kpis}`).then(setKpis).catch(() => setKpis(null));
    apiFetch<AdminOnboardingAnalyticsDto>(`${ADMIN_ONBOARDING}/${ADMIN_PATHS.analytics}`).then(setAnalytics).catch(() => setAnalytics(null));
  }, []);

  const setFilter = (key: keyof typeof EMPTY_FILTERS, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };
  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Field onboarding</p>
          <h1 style={{ fontSize: "1.7rem" }}>Salon Onboarding</h1>
          <p>Applications submitted by field employees. Approval creates a hidden salon and invites the owner; publishing is a separate step.</p>
        </div>
        <div className={styles.headerActions}>
          <LinkButton href="/dashboard/admin" variant="outline">Back to admin</LinkButton>
        </div>
      </header>

      <section className={styles.metrics} aria-label="Onboarding KPIs">
        {[
          ["Total applications", kpis?.total],
          ["Drafts", kpis?.drafts],
          ["Pending review", kpis?.pendingReview],
          ["Changes requested", kpis?.changesRequested],
          ["Approved", kpis?.approved],
          ["Rejected", kpis?.rejected],
          ["Awaiting owner activation", kpis?.awaitingOwnerActivation],
          ["Active salons", kpis?.activeSalons],
          ["Avg review time", kpis ? (kpis.averageReviewHours === null ? "—" : `${kpis.averageReviewHours} h`) : undefined],
          ["Pending > 48 h", kpis?.pendingOver48Hours],
        ].map(([label, value]) => (
          <article key={label as string} className={label === "Pending > 48 h" && Number(value) > 0 ? local.warn : undefined}>
            <strong>{value ?? "…"}</strong>
            <span>{label}</span>
          </article>
        ))}
      </section>

      <section className={local.filterGrid} aria-label="Filters">
        <label>Search<input type="search" value={filters.q} placeholder="ID, salon, owner, phone…" onChange={(e) => setFilter("q", e.target.value)} /></label>
        <label>Status<select value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">All statuses</option>
          {Object.values(OnboardingStatus).map((s) => <option key={s} value={s}>{ONBOARDING_STATUS_LABELS[s]}</option>)}
        </select></label>
        <label>City<input value={filters.city} onChange={(e) => setFilter("city", e.target.value)} /></label>
        <label>Territory<input value={filters.territory} onChange={(e) => setFilter("territory", e.target.value)} /></label>
        <label>Employee<select value={filters.employeeId} onChange={(e) => setFilter("employeeId", e.target.value)}>
          <option value="">All employees</option>
          {kpis?.byEmployee.map((e) => <option key={e.employeeId} value={e.employeeId}>{e.fullName} ({e.employeeCode})</option>)}
        </select></label>
        <label>Submitted from<input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} /></label>
        <label>Submitted to<input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} /></label>
        <label>Missing info<select value={filters.missingInfo} onChange={(e) => setFilter("missingInfo", e.target.value)}>
          <option value="">Any</option>
          <option value="true">Has missing info</option>
          <option value="false">Complete</option>
        </select></label>
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <section className={styles.section}>
        <div className={styles.sectionHeader}><h2>Applications</h2><span>{list ? `${list.total} found` : "Loading…"}</span></div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Onboarding ID</th><th>Salon</th><th>City / area</th><th>Owner</th><th>Employee</th>
                <th>Submitted</th><th>Status</th><th>Services</th><th>Photos</th><th>Updated</th><th>Reviewer</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list?.items.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.reference}</code></td>
                  <td><strong>{item.salonName}</strong>{item.missingCount > 0 && <small className={local.warn}>{item.missingCount} missing</small>}</td>
                  <td>{item.city ?? "—"}<small>{item.locality ?? ""}</small></td>
                  <td>{item.ownerName ?? "—"}<small>{item.ownerPhone ?? ""}</small></td>
                  <td>{item.employee.fullName}<small>{item.employee.employeeCode}</small></td>
                  <td>{when(item.submittedAt)}</td>
                  <td><span className={styles.status}>{ONBOARDING_STATUS_LABELS[item.status]}</span></td>
                  <td>{item.serviceCount}</td>
                  <td>{item.photoCount}</td>
                  <td>{when(item.updatedAt)}</td>
                  <td>{item.reviewer?.name ?? "Unassigned"}</td>
                  <td><Link href={`/dashboard/admin/onboarding/${item.id}`}>Review</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list && list.items.length === 0 && <p className={styles.empty}>No applications match these filters.</p>}
        <div className={local.pager}>
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      </section>

      <div className={local.breakdown}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}><h2>By employee</h2></div>
          <table className={local.miniTable}>
            <thead><tr><th>Employee</th><th>Applications</th><th>Approved</th></tr></thead>
            <tbody>{kpis?.byEmployee.map((e) => (
              <tr key={e.employeeId}><td>{e.fullName}</td><td>{e.total}</td><td>{e.approved}</td></tr>
            ))}</tbody>
          </table>
        </section>
        <section className={styles.section}>
          <div className={styles.sectionHeader}><h2>By city</h2></div>
          <table className={local.miniTable}>
            <thead><tr><th>City</th><th>Applications</th><th>Approved</th></tr></thead>
            <tbody>{kpis?.byCity.map((c) => (
              <tr key={c.city}><td>{c.city}</td><td>{c.total}</td><td>{c.approved}</td></tr>
            ))}</tbody>
          </table>
        </section>
      </div>

      {analytics && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2>Field team funnel</h2>
            <span>Lead → submitted → approved → owner activated → live → receiving bookings (separate counts)</span>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Employee</th><th>Visits</th><th>Leads</th><th>Started</th><th>Submitted</th><th>Approved</th><th>Rejected</th><th>Owner active</th><th>Live</th><th>Bookings</th><th>Corrections</th><th>Days to approve</th><th>Days to activate</th><th>Conversion</th></tr></thead>
              <tbody>
                {[{ employeeId: "team", fullName: "Whole team", employeeCode: "", territory: null, ...analytics.team }, ...analytics.employees].map((row) => (
                  <tr key={row.employeeId}>
                    <td><strong>{row.fullName}</strong><small>{row.territory ?? row.employeeCode}</small></td>
                    <td>{row.visits}</td><td>{row.leadsCreated}</td><td>{row.applicationsStarted}</td><td>{row.applicationsSubmitted}</td>
                    <td>{row.approved}</td><td>{row.rejected}</td><td>{row.ownerActivated}</td><td>{row.publiclyActive}</td><td>{row.receivingBookings}</td>
                    <td>{row.pendingCorrections}</td><td>{row.avgDaysSubmissionToApproval ?? "—"}</td><td>{row.avgDaysApprovalToActivation ?? "—"}</td>
                    <td>{row.conversionRate === null ? "—" : `${row.conversionRate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
