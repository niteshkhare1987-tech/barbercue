"use client";

import { useEffect, useState } from "react";
import {
  FORECAST_PATHS,
  INVENTORY_PATHS,
  analyticsCsv,
  type ForecastSettingsInput,
  type InventoryAnalyticsDto,
  type InventoryPredictionsDto,
  type ProductPredictionDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { moneyText, quantityText } from "../../../lib/inventory";
import { inventoryBase } from "../../../lib/use-inventory-lookups";
import { Badge, Banner, Btn, BtnLink, Card, EmptyState, Field, Skeleton } from "../parts";
import ui from "../owner.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);

function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void apiFetch<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, "Could not load this page."));
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);
  return { data, error, loading: !data && !error, reload: () => setVersion((v) => v + 1) };
}

const STATUS: Record<ProductPredictionDto["status"], { text: string; tone: "bad" | "warn" | "info" | "ok" | "neutral" }> = {
  OUT_OF_STOCK: { text: "Out of stock", tone: "bad" },
  ORDER_NOW: { text: "Order now", tone: "bad" },
  ORDER_SOON: { text: "Order soon", tone: "warn" },
  OK: { text: "OK", tone: "ok" },
  NO_DATA: { text: "No prediction", tone: "neutral" },
};
const CONFIDENCE: Record<ProductPredictionDto["confidence"], string> = {
  NOT_ENOUGH_DATA: "Not enough data",
  LOW: "Low confidence",
  MEDIUM: "Medium confidence",
  HIGH: "High confidence",
};
const TREND: Record<ProductPredictionDto["trend"], string> = { UP: "↑ rising", DOWN: "↓ falling", STEADY: "→ steady", UNKNOWN: "" };

function SettingsCard({ salonId, data, onSaved }: { salonId: string; data: InventoryPredictionsDto; onSaved: () => void }) {
  const [form, setForm] = useState({
    leadTimeDays: String(data.settings.leadTimeDays),
    safetyDays: String(data.settings.safetyDays),
    coverDays: String(data.settings.coverDays),
    alertsEnabled: data.settings.alertsEnabled,
  });
  const [leadTimes, setLeadTimes] = useState<Record<string, string>>(Object.fromEntries(data.suppliers.map((s) => [s.id, s.leadTimeDays == null ? "" : String(s.leadTimeDays)])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);

  async function save() {
    const body: ForecastSettingsInput = { leadTimeDays: int(form.leadTimeDays), safetyDays: int(form.safetyDays), coverDays: int(form.coverDays), alertsEnabled: form.alertsEnabled };
    if ([body.leadTimeDays, body.safetyDays, body.coverDays].some((n) => !Number.isInteger(n)) || body.coverDays < 1)
      return setMessage({ tone: "error", text: "Use whole days (an order must cover at least 1 day)." });
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`${inventoryBase(salonId)}/${FORECAST_PATHS.settings}`, { method: "PUT", body: JSON.stringify(body) });
      for (const s of data.suppliers) {
        const v = leadTimes[s.id]?.trim() ?? "";
        const next = v === "" ? null : int(v);
        if (next !== null && !Number.isInteger(next)) throw new Error(`Lead time for ${s.name} must be whole days.`);
        if (next !== s.leadTimeDays)
          await apiFetch(`${inventoryBase(salonId)}/${INVENTORY_PATHS.suppliers}/${s.id}/${FORECAST_PATHS.leadTime}`, { method: "PUT", body: JSON.stringify({ leadTimeDays: next }) });
      }
      setMessage({ tone: "ok", text: "Saved. Predictions are updated." });
      onSaved();
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error && !(err instanceof ApiError) ? err.message : errorText(err, "Not saved — try again.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Assumptions" sub="Predictions use these. A supplier's own delivery time wins over the shop's default.">
      <div className={ui.rowWrap}>
        <Field label="Delivery takes (days)" htmlFor="fc-lead"><input id="fc-lead" className={ui.input} inputMode="numeric" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} /></Field>
        <Field label="Cushion (days of extra stock)" htmlFor="fc-safety"><input id="fc-safety" className={ui.input} inputMode="numeric" value={form.safetyDays} onChange={(e) => setForm({ ...form, safetyDays: e.target.value })} /></Field>
        <Field label="Each order covers (days)" htmlFor="fc-cover"><input id="fc-cover" className={ui.input} inputMode="numeric" value={form.coverDays} onChange={(e) => setForm({ ...form, coverDays: e.target.value })} /></Field>
      </div>
      {data.suppliers.length > 0 && (
        <div className={ui.rowWrap}>
          {data.suppliers.map((s) => (
            <Field key={s.id} label={`${s.name}: delivery days`} htmlFor={`fc-sup-${s.id}`} hint="Empty = shop default">
              <input id={`fc-sup-${s.id}`} className={ui.input} inputMode="numeric" value={leadTimes[s.id] ?? ""} onChange={(e) => setLeadTimes({ ...leadTimes, [s.id]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
      <label className={ui.label}>
        <input type="checkbox" checked={form.alertsEnabled} onChange={(e) => setForm({ ...form, alertsEnabled: e.target.checked })} /> Send me a notification when something needs reordering or is about to expire (checked once a day)
      </label>
      {message && <div className={ui.mt12}><Banner tone={message.tone === "ok" ? "ok" : "error"}>{message.text}</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <Btn variant="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
      </div>
    </Card>
  );
}

/** Owner: per-product predictions, reorder recommendations, alerts and the assumptions behind them. */
export function PredictionsView({ salonId }: { salonId: string }) {
  const { data, error, loading, reload } = useResource<InventoryPredictionsDto>(`${inventoryBase(salonId)}/${FORECAST_PATHS.predictions}`);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (loading) return <div className={ui.mt16}><Skeleton height={200} /></div>;
  if (error || !data) return <div className={ui.mt16}><Banner tone="error">{error ?? "No predictions."} <Btn small onClick={reload}>Try again</Btn></Banner></div>;

  async function checkNow() {
    setBusy(true);
    try {
      const r = await apiFetch<{ created: number; resolved: number }>(`${inventoryBase(salonId)}/${FORECAST_PATHS.runAlerts}`, { method: "POST" });
      setNotice(r.created || r.resolved ? `${r.created} new alert${r.created === 1 ? "" : "s"}, ${r.resolved} cleared.` : "Nothing new.");
      reload();
    } catch (err) {
      setNotice(errorText(err, "Could not check now."));
    } finally {
      setBusy(false);
    }
  }
  async function dismiss(id: string) {
    try {
      await apiFetch(`${inventoryBase(salonId)}/${FORECAST_PATHS.alerts}/${id}/${FORECAST_PATHS.dismiss}`, { method: "POST" });
      reload();
    } catch (err) {
      setNotice(errorText(err, "Could not dismiss."));
    }
  }

  const s = data.summary;
  return (
    <div className={ui.mt16}>
      <Card
        title="Predictions"
        sub={`Worked out from your recorded use (last 8 weeks, recent weeks count more), upcoming bookings and delivery times, as of ${data.asOf}. Estimates, not guarantees.`}
        action={<Btn small onClick={() => void checkNow()} disabled={busy}>{busy ? "Checking…" : "Check for alerts now"}</Btn>}
      >
        <div className={ui.statGrid}>
          <div className={ui.stat}><div className={ui.statLabel}>Order now</div><div className={ui.statValue}>{s.orderNow + s.outOfStock}</div></div>
          <div className={ui.stat}><div className={ui.statLabel}>Order within a week</div><div className={ui.statValue}>{s.orderSoon}</div></div>
          <div className={ui.stat}><div className={ui.statLabel}>Expiring stock at risk</div><div className={ui.statValue}>{s.expiringAtRisk}</div></div>
          <div className={ui.stat}><div className={ui.statLabel}>Not enough data yet</div><div className={ui.statValue}>{s.notEnoughData}</div></div>
        </div>
        {notice && <div className={ui.mt12} role="status"><Banner tone="info">{notice}</Banner></div>}
      </Card>

      {data.alerts.length > 0 && (
        <div className={ui.mt16}>
          <Card title="Alerts" sub="Each problem is raised once and clears itself when it is fixed.">
            {data.alerts.map((a) => (
              <div key={a.id} className={`${ui.rowWrap} ${ui.mt12}`} style={{ justifyContent: "space-between" }}>
                <div>
                  <Badge tone={a.kind === "EXPIRING" ? "warn" : "bad"}>{a.kind === "REORDER" ? "Reorder" : a.kind === "STOCK_OUT" ? "Out of stock" : a.kind === "EXPIRED" ? "Expired" : "Expiring"}</Badge>{" "}
                  <strong>{a.title}</strong>
                  <div className={ui.hint}>{a.detail}</div>
                </div>
                <Btn small variant="quiet" onClick={() => void dismiss(a.id)}>Dismiss</Btn>
              </div>
            ))}
          </Card>
        </div>
      )}

      <div className={ui.mt16}>
        <Card title="Products">
          {data.products.length === 0 ? (
            <EmptyState title="No products yet" />
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead>
                  <tr><th>Product</th><th className={ui.num}>In stock</th><th className={ui.num}>Use per day</th><th className={ui.num}>Days left</th><th>Runs out</th><th>Order by</th><th className={ui.num}>Suggested order</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.productId}>
                      <td>
                        {p.name}
                        <div className={ui.hint}>
                          {[p.categoryName, p.supplierName ? `${p.supplierName} · ${p.leadTimeDays} days delivery` : `${p.leadTimeDays} days delivery`].filter(Boolean).join(" · ")}
                        </div>
                        {p.expiry.map((e) => (
                          <div key={`${e.batchNumber}-${e.expiryDate}`} className={ui.hint}>
                            <Badge tone={e.daysToExpiry < 0 ? "bad" : "warn"}>{e.daysToExpiry < 0 ? "Expired" : `Expires ${e.expiryDate}`}</Badge>{" "}
                            {e.batchNumber ? `Batch ${e.batchNumber}: ` : ""}about {quantityText(String(e.remaining), p.unit)} left{e.atRisk > 0 ? `, ~${quantityText(String(e.atRisk), p.unit)} may not be used in time` : ""}
                          </div>
                        ))}
                      </td>
                      <td className={ui.num}>{quantityText(p.stockOnHand, p.unit)}</td>
                      <td className={ui.num}>{p.dailyRate != null ? <>{quantityText(String(p.dailyRate), p.unit)}<div className={ui.hint}>{TREND[p.trend]}</div></> : "—"}</td>
                      <td className={ui.num}>{p.daysLeft != null ? Math.floor(p.daysLeft) : "—"}</td>
                      <td>{p.stockOutDate ?? "—"}</td>
                      <td>{p.reorderDate ?? "—"}</td>
                      <td className={ui.num}>{p.suggestedOrderQuantity ? quantityText(String(p.suggestedOrderQuantity), p.unit) : "—"}</td>
                      <td>
                        <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].text}</Badge>
                        <div className={ui.hint}>{CONFIDENCE[p.confidence]}</div>
                        <div className={ui.hint}>{p.explanation}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className={ui.mt16}>
        <SettingsCard salonId={salonId} data={data} onSaved={reload} />
      </div>
    </div>
  );
}

/** Overview card: what to order, linking to Predictions. */
export function ReorderSummary({ salonId }: { salonId: string }) {
  const { data } = useResource<InventoryPredictionsDto>(`${inventoryBase(salonId)}/${FORECAST_PATHS.predictions}`);
  if (!data || data.products.length === 0) return null;
  const urgent = data.products.filter((p) => p.status === "OUT_OF_STOCK" || p.status === "ORDER_NOW" || p.status === "ORDER_SOON").slice(0, 4);
  return (
    <Card title="Reorder" action={<BtnLink small variant="quiet" href={`/dashboard/salons/${salonId}/inventory/predictions`}>All predictions</BtnLink>}>
      {urgent.length === 0 ? (
        <p className={ui.cardSub}>Nothing needs ordering this week{data.summary.notEnoughData ? ` (${data.summary.notEnoughData} product${data.summary.notEnoughData === 1 ? " has" : "s have"} not enough data yet)` : ""}.</p>
      ) : (
        urgent.map((p) => (
          <div key={p.productId} className={ui.mt12}>
            <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].text}</Badge> <strong>{p.name}</strong>
            <span className={ui.hint}>
              {" "}
              {p.reorderDate ? `· order by ${p.reorderDate}` : ""}
              {p.suggestedOrderQuantity ? ` · suggested ${quantityText(String(p.suggestedOrderQuantity), p.unit)}` : ""}
            </span>
          </div>
        ))
      )}
    </Card>
  );
}

/** Reports: a period's received / used / written-off by product, week and category, with a CSV download. */
export function AnalyticsView({ salonId }: { salonId: string }) {
  const [days, setDays] = useState(30);
  // The server counts back from the shop's own today (its time zone), not this device's date.
  const { data, error, loading } = useResource<InventoryAnalyticsDto>(`${inventoryBase(salonId)}/${FORECAST_PATHS.analytics}?days=${days}`);
  const money = (v: string) => moneyText(v, data?.currency ?? null);

  function download() {
    if (!data) return;
    const blob = new Blob([analyticsCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-${data.range.from}-to-${data.range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card
      title="Consumption analytics"
      sub={data ? `${data.range.from} to ${data.range.to}. Values at cost.` : undefined}
      action={
        <div className={ui.rowWrap}>
          <select aria-label="Period" className={ui.input} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
          </select>
          <Btn small onClick={download} disabled={!data}>Download CSV</Btn>
        </div>
      }
    >
      {loading ? (
        <Skeleton height={120} />
      ) : error || !data ? (
        <Banner tone="error">{error}</Banner>
      ) : (
        <>
          <div className={ui.statGrid}>
            <div className={ui.stat}><div className={ui.statLabel}>Bought</div><div className={ui.statValue}>{money(data.totals.receivedValue)}</div></div>
            <div className={ui.stat}><div className={ui.statLabel}>Used</div><div className={ui.statValue}>{money(data.totals.usedValue)}</div></div>
            <div className={ui.stat}><div className={ui.statLabel}>Damaged / expired / wasted</div><div className={ui.statValue}>{money(data.totals.lostValue)}</div></div>
            <div className={ui.stat}><div className={ui.statLabel}>Stock now</div><div className={ui.statValue}>{money(data.totals.stockValue)}</div></div>
          </div>
          {data.byWeek.length > 0 && (
            <div className={`${ui.tableWrap} ${ui.mt12}`}>
              <table className={ui.table}>
                <caption className={ui.cardSub}>By week (weeks start on Monday)</caption>
                <thead><tr><th>Week of</th><th className={ui.num}>Bought</th><th className={ui.num}>Used</th><th className={ui.num}>Written off</th></tr></thead>
                <tbody>{data.byWeek.map((w) => <tr key={w.weekStart}><td>{w.weekStart}</td><td className={ui.num}>{money(w.receivedValue)}</td><td className={ui.num}>{money(w.usedValue)}</td><td className={ui.num}>{money(w.lostValue)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {data.byCategory.length > 0 && (
            <div className={`${ui.tableWrap} ${ui.mt12}`}>
              <table className={ui.table}>
                <caption className={ui.cardSub}>By category</caption>
                <thead><tr><th>Category</th><th className={ui.num}>Bought</th><th className={ui.num}>Used</th></tr></thead>
                <tbody>{data.byCategory.map((c) => <tr key={c.categoryName}><td>{c.categoryName}</td><td className={ui.num}>{money(c.receivedValue)}</td><td className={ui.num}>{money(c.usedValue)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <div className={`${ui.tableWrap} ${ui.mt12}`}>
            <table className={ui.table}>
              <caption className={ui.cardSub}>By product</caption>
              <thead><tr><th>Product</th><th className={ui.num}>Bought</th><th className={ui.num}>Used</th><th className={ui.num}>Written off</th><th className={ui.num}>Stock now</th></tr></thead>
              <tbody>
                {data.products.map((p) => (
                  <tr key={p.productId}>
                    <td>{p.name}<div className={ui.hint}>{p.categoryName ?? ""}</div></td>
                    <td className={ui.num}>{quantityText(p.receivedQuantity, p.unit)}<div className={ui.hint}>{money(p.receivedValue)}</div></td>
                    <td className={ui.num}>{quantityText(p.usedQuantity, p.unit)}<div className={ui.hint}>{money(p.usedValue)}</div></td>
                    <td className={ui.num}>{quantityText(p.lostQuantity, p.unit)}<div className={ui.hint}>{money(p.lostValue)}</div></td>
                    <td className={ui.num}>{quantityText(p.stockOnHand, p.unit)}<div className={ui.hint}>{money(p.stockValue)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
