"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ADMIN_PATHS, ADMIN_ADOPTION_THRESHOLDS, type AdminExecutiveOverviewDto, type AdminKpiValue } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { Button, LinkButton } from "../../ui/Button";
import { AreaChart } from "../../owner/charts";
import {
  COMMAND_CENTER_PRESETS,
  formatRangeLabel,
  presetRange,
  rangeError,
  type ShopActivityPreset,
} from "../shop-activity-range";
import {
  ADOPTION_LABELS,
  ADOPTION_ORDER,
  describeChange,
  formatCount,
  formatInr,
  formatKpi,
  shopsCsv,
  type KpiKind,
} from "./format";
import styles from "../../../app/(dashboard)/dashboard/admin/command-center/command-center.module.css";

// The chart's average line is fractional (e.g. 0.2 visits a day); a whole-number format would read "Average 0".
const formatChartValue = (value: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(value);

interface KpiCard {
  label: string;
  value: AdminKpiValue;
  kind: KpiKind;
  definition: string;
  note?: string;
}

function KpiTile({ card, previousLabel }: { card: KpiCard; previousLabel: string }) {
  const change = describeChange(card.value, card.kind);
  return (
    <article className={styles.kpi} title={card.definition}>
      <h3>{card.label}</h3>
      <strong>{formatKpi(card.value.current, card.kind)}</strong>
      <p className={styles.kpiChange} data-direction={change.direction}>
        {change.direction === "up" && <span aria-hidden="true">▲ </span>}
        {change.direction === "down" && <span aria-hidden="true">▼ </span>}
        {change.text}
        {change.direction !== "none" && (
          <span className={styles.kpiVs} title={previousLabel}> vs previous period</span>
        )}
      </p>
      {card.note && <p className={styles.kpiNote}>{card.note}</p>}
    </article>
  );
}

/**
 * Executive Command Center (docs/admin-dashboard-2.0). Every figure comes from
 * GET admin/analytics/overview; nothing on this page is sample data. "—" means not measurable.
 */
export function CommandCenter() {
  const [preset, setPreset] = useState<ShopActivityPreset>("last30");
  const [range, setRange] = useState(() => presetRange("last30"));
  const [draft, setDraft] = useState(range);
  const [data, setData] = useState<AdminExecutiveOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      setData(await apiFetch<AdminExecutiveOverviewDto>(`${ADMIN_PATHS.admin}/${ADMIN_PATHS.analytics}/${ADMIN_PATHS.overview}?${params}`));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : "Could not load the command center.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(range.from, range.to), 0);
    return () => window.clearTimeout(timer);
  }, [load, range]);

  function choosePreset(id: Exclude<ShopActivityPreset, "custom">) {
    const next = presetRange(id);
    setPreset(id);
    setRange(next);
    setDraft(next);
  }
  const draftError = preset === "custom" ? rangeError(draft.from, draft.to) : null;

  // Only render numbers that belong to the range on screen.
  const current = data && data.from === range.from && data.to === range.to ? data : null;
  const previousLabel = current ? formatRangeLabel(current.previousFrom, current.previousTo) : "";

  const cards: KpiCard[] = current
    ? [
        { label: "Registered salons", value: current.kpis.registeredSalons, kind: "count", definition: "Salons created on or before the last day of the period." },
        { label: "Serving salons", value: current.kpis.servingSalons, kind: "count", definition: "Salons with at least one completed appointment or served walk-in in the period.", note: `${formatCount(current.kpis.openSalonsNow)} open for customers right now` },
        { label: "Completed visits", value: current.kpis.completedVisits, kind: "count", definition: "Completed appointments (by appointment date) plus walk-ins served (by join date)." },
        { label: "Appointments booked", value: current.kpis.appointmentsBooked, kind: "count", definition: "Appointments created in the period, whatever their appointment date or outcome." },
        { label: "Completed appointments", value: current.kpis.appointmentsCompleted, kind: "count", definition: "Scheduled appointments in the period that were completed. A checked-in appointment stays scheduled." },
        { label: "Walk-ins served", value: current.kpis.walkInsServed, kind: "count", definition: "Live-queue walk-ins that joined in the period and were completed." },
        {
          label: "Completed service value",
          value: current.kpis.completedServiceValuePaise,
          kind: "money",
          definition: "Salon service value — not FastQue revenue. Appointments use the booked price snapshot after the online discount; walk-ins use the current menu price (estimate).",
          note: current.kpis.walkInValueEstimatePaise.current
            ? `Includes ${formatInr(current.kpis.walkInValueEstimatePaise.current)} estimated walk-in value`
            : undefined,
        },
        { label: "Average visit value", value: current.kpis.averageVisitValuePaise, kind: "money", definition: "Completed service value ÷ completed visits with a known value." },
        { label: "Service hours", value: current.kpis.completedServiceMinutes, kind: "minutes", definition: "Actual start-to-end time of completed service sessions that ended in the period." },
        { label: "Cancellation rate", value: current.kpis.cancellationRatePercent, kind: "percent", definition: "Cancelled ÷ (completed + cancelled + no-show) appointments. Pending appointments are excluded." },
        { label: "No-show rate", value: current.kpis.noShowRatePercent, kind: "percent", definition: "No-shows ÷ (completed + no-show) appointments." },
      ]
    : [];

  const normalizedSearch = search.trim().toLowerCase();
  const shops = useMemo(
    () =>
      (current?.shops ?? []).filter(
        (s) => !normalizedSearch || `${s.name} ${s.publicId} ${s.city}`.toLowerCase().includes(normalizedSearch),
      ),
    [current, normalizedSearch],
  );

  const trendPoints = (current?.trend ?? []).map((d) => ({
    label: new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d.date}T00:00:00Z`)),
    value: d.appointmentsCompleted + d.walkInsServed,
  }));
  const trendHasData = trendPoints.some((p) => p.value > 0);

  function downloadCsv() {
    if (!current) return;
    const blob = new Blob([`﻿${shopsCsv(current)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `fastque-salon-performance-${current.from}-to-${current.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Executive overview</p>
          <h1>FastQue Command Center</h1>
          <p className={styles.subtitle}>
            Live data · India time (IST)
            {current && ` · refreshed ${new Intl.DateTimeFormat("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(current.generatedAt))}`}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button type="button" variant="outline" onClick={() => void load(range.from, range.to)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <LinkButton href="/dashboard/admin" variant="outline">Platform operations</LinkButton>
        </div>
      </header>

      <section className={styles.filters} aria-label="Reporting period">
        <div className={styles.presets} role="group" aria-label="Date range">
          {COMMAND_CENTER_PRESETS.map((option) => (
            <Button key={option.id} type="button" variant={preset === option.id ? "primary" : "outline"} aria-pressed={preset === option.id} onClick={() => choosePreset(option.id)}>
              {option.label}
            </Button>
          ))}
          <Button type="button" variant={preset === "custom" ? "primary" : "outline"} aria-pressed={preset === "custom"} onClick={() => setPreset("custom")}>
            Custom range
          </Button>
        </div>
        {preset === "custom" && (
          <form className={styles.customRange} onSubmit={(event) => { event.preventDefault(); if (!draftError) setRange({ ...draft }); }}>
            <div>
              <label htmlFor="cc-from">From</label>
              <input id="cc-from" type="date" value={draft.from} onChange={(event) => setDraft((d) => ({ ...d, from: event.target.value }))} />
            </div>
            <div>
              <label htmlFor="cc-to">To</label>
              <input id="cc-to" type="date" value={draft.to} onChange={(event) => setDraft((d) => ({ ...d, to: event.target.value }))} />
            </div>
            <Button type="submit" disabled={!!draftError}>Apply</Button>
            {draftError && <p className={styles.rangeError} role="alert">{draftError}</p>}
          </form>
        )}
        <p className={styles.period}>
          {formatRangeLabel(range.from, range.to)}
          {current && <> · compared with {previousLabel}</>}
        </p>
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {!current && !error && <p className={styles.muted} role="status">Loading the command center…</p>}

      {current && (
        <>
          <section className={styles.kpiGrid} aria-label="Key figures">
            {cards.map((card) => <KpiTile key={card.label} card={card} previousLabel={previousLabel} />)}
            <article className={`${styles.kpi} ${styles.kpiUnavailable}`} title="FastQue's own earnings (commissions, fees, subscriptions) are not recorded yet, so this is not shown as zero.">
              <h3>FastQue platform revenue</h3>
              <strong>Not tracked yet</strong>
              <p className={styles.kpiNote}>Needs a platform-fee ledger. Salon service value is not FastQue revenue.</p>
            </article>
          </section>

          <div className={styles.chartRow}>
            <section className={styles.card} aria-labelledby="cc-trend">
              <h2 id="cc-trend">Completed visits per day</h2>
              <p className={styles.muted}>Completed appointments + walk-ins served, {formatRangeLabel(current.from, current.to)}</p>
              {trendHasData ? (
                <AreaChart points={trendPoints} formatValue={formatChartValue} ariaLabel="Completed visits per day" />
              ) : (
                <p className={styles.empty}>No completed visits in this period.</p>
              )}
            </section>

            <section className={styles.card} aria-labelledby="cc-adoption">
              <h2 id="cc-adoption">Shop adoption</h2>
              <p className={styles.muted}>
                {formatCount(current.adoption.totalSalons)} salons · last {current.adoption.windowDays} days to {formatRangeLabel(current.adoption.asOf, current.adoption.asOf)}
              </p>
              <ul className={styles.adoptionList}>
                {ADOPTION_ORDER.map((category) => {
                  const n = current.adoption.counts[category];
                  const share = current.adoption.totalSalons ? (n / current.adoption.totalSalons) * 100 : 0;
                  return (
                    <li key={category}>
                      <div className={styles.adoptionLabel}>
                        <span>{ADOPTION_LABELS[category]}</span>
                        <span>{formatCount(n)} · {share.toFixed(0)}%</span>
                      </div>
                      <div className={styles.adoptionTrack} aria-hidden="true">
                        <div className={styles.adoptionBar} style={{ width: `${share}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className={styles.footnote}>
                Highly active ≥ {ADMIN_ADOPTION_THRESHOLDS.highlyActiveMinVisits}, moderate ≥ {ADMIN_ADOPTION_THRESHOLDS.moderatelyActiveMinVisits}, low 1–{ADMIN_ADOPTION_THRESHOLDS.moderatelyActiveMinVisits - 1} completed visits in {ADMIN_ADOPTION_THRESHOLDS.windowDays} days. At risk: down ≥ {ADMIN_ADOPTION_THRESHOLDS.atRiskDropPercent}% from a previous {ADMIN_ADOPTION_THRESHOLDS.windowDays} days of ≥ {ADMIN_ADOPTION_THRESHOLDS.atRiskMinBaselineVisits}. Merchant app usage is not tracked yet.
              </p>
            </section>
          </div>

          <section className={styles.card} aria-labelledby="cc-shops">
            <div className={styles.tableHeader}>
              <div>
                <h2 id="cc-shops">Salon performance</h2>
                <p className={styles.muted}>
                  {current.shopsTotal > current.shopsLimit
                    ? `Top ${current.shopsLimit} of ${formatCount(current.shopsTotal)} salons with activity`
                    : `${formatCount(current.shopsTotal)} salons with activity`} · most completed visits first
                </p>
              </div>
              <div className={styles.tableTools}>
                <label htmlFor="cc-search" className={styles.visuallyHidden}>Search salons</label>
                <input id="cc-search" type="search" placeholder="Search salon, ID or city" value={search} onChange={(event) => setSearch(event.target.value)} />
                <Button type="button" variant="outline" onClick={downloadCsv} disabled={current.shops.length === 0}>Export CSV</Button>
              </div>
            </div>
            <div className={styles.tableWrap}>
              <table>
                <caption className={styles.visuallyHidden}>Salon performance, {formatRangeLabel(current.from, current.to)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Salon</th>
                    <th scope="col">City</th>
                    <th scope="col">Adoption</th>
                    <th scope="col">Completed visits</th>
                    <th scope="col">Appointments</th>
                    <th scope="col">Walk-ins</th>
                    <th scope="col">Cancelled</th>
                    <th scope="col">No-show</th>
                    <th scope="col">Service value</th>
                  </tr>
                </thead>
                <tbody>
                  {shops.map((s) => (
                    <tr key={s.id}>
                      <th scope="row"><strong>{s.name}</strong><small>{s.publicId}</small></th>
                      <td>{s.city}</td>
                      <td><span className={styles.badge}>{ADOPTION_LABELS[s.adoption]}</span></td>
                      <td>{formatCount(s.completedVisits)}</td>
                      <td>{formatCount(s.appointmentsCompleted)}</td>
                      <td>{formatCount(s.walkInsServed)}</td>
                      <td>{formatCount(s.cancelled)}</td>
                      <td>{formatCount(s.noShow)}</td>
                      <td>{formatInr(s.serviceValuePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shops.length === 0 && (
              <p className={styles.empty}>
                {current.shops.length === 0 ? "No salon had appointments or walk-ins in this period." : "No salons match this search."}
              </p>
            )}
          </section>

          <details className={styles.definitions}>
            <summary>How these numbers are calculated</summary>
            <dl>
              {cards.map((card) => (
                <div key={card.label}><dt>{card.label}</dt><dd>{card.definition}</dd></div>
              ))}
              <div><dt>Previous period</dt><dd>The same number of days immediately before the selected range ({previousLabel}).</dd></div>
              <div><dt>Not shown yet</dt><dd>FastQue platform revenue, merchant app engagement, chair utilisation and sales-territory views need data that is not recorded yet — see docs/admin-dashboard-2.0/PLAN.md.</dd></div>
            </dl>
          </details>
        </>
      )}
    </main>
  );
}
