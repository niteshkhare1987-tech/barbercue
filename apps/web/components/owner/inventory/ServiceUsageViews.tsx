"use client";

import { useEffect, useState } from "react";
import {
  INVENTORY_PATHS,
  SERVICE_USAGE_PATHS,
  type InventoryCategoryDto,
  type InventoryDashboardDto,
  type InventoryProductDto,
  type InventoryUnit,
  type ServiceRecipeDto,
  type ServiceVisitsDto,
  type UsageRecordDto,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { moneyText, quantityText, trimDecimal, unitShort, UNIT_OPTIONS } from "../../../lib/inventory";
import { inventoryBase, loadAll } from "../../../lib/use-inventory-lookups";
import { Badge, Banner, Btn, BtnLink, Card, Dialog, EmptyState, Field, Skeleton } from "../parts";
import { formatShopTime } from "../format";
import { ServiceUsageDialog } from "./ServiceUsageDialog";
import ui from "../owner.module.css";
import styles from "./usage.module.css";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const RECIPE_UNITS: readonly InventoryUnit[] = ["MILLILITER", "LITER", "GRAM", "KILOGRAM", "EACH", "PACK", "BOX"];

/** Loads one JSON resource; `reload` fetches it again. */
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

const usageText = (u: UsageRecordDto) => u.items.map((i) => `${i.productName} ${trimDecimal(i.enteredQuantity)} ${unitShort(i.enteredUnit)}`).join(", ");

// ---------- Service recipes ----------

type Line = { inventoryCategoryId: string; quantity: string; unit: InventoryUnit; defaultProductId: string; autoDeduct: boolean };

function RecipeEditor({
  salonId,
  recipe,
  categories,
  products,
  onCategoryCreated,
  onSaved,
}: {
  salonId: string;
  recipe: ServiceRecipeDto;
  categories: InventoryCategoryDto[];
  products: InventoryProductDto[];
  onCategoryCreated: (c: InventoryCategoryDto) => void;
  onSaved: (r: ServiceRecipeDto) => void;
}) {
  const [lines, setLines] = useState<Line[]>(
    recipe.lines.map((l) => ({ inventoryCategoryId: l.inventoryCategoryId, quantity: trimDecimal(l.quantity), unit: l.unit, defaultProductId: l.defaultProductId ?? "", autoDeduct: l.autoDeduct })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (i: number, patch: Partial<Line>) => {
    setSaved(false);
    setLines((all) => all.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  };
  const used = new Set(lines.map((l) => l.inventoryCategoryId));

  async function addSuggestion(name: string) {
    setError(null);
    let category = categories.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (!category) {
      try {
        category = await apiFetch<InventoryCategoryDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.categories}`, { method: "POST", body: JSON.stringify({ name }) });
        onCategoryCreated(category);
      } catch (err) {
        return setError(errorText(err, `The category "${name}" could not be added.`));
      }
    }
    if (!used.has(category.id)) setLines((all) => [...all, { inventoryCategoryId: category!.id, quantity: "1", unit: "EACH", defaultProductId: "", autoDeduct: false }]);
  }

  async function save() {
    setError(null);
    const body = {
      lines: lines
        .filter((l) => l.inventoryCategoryId)
        .map((l) => ({
          inventoryCategoryId: l.inventoryCategoryId,
          quantity: Math.round(Number(l.quantity) * 1000) / 1000,
          unit: l.unit,
          defaultProductId: l.defaultProductId || null,
          autoDeduct: Boolean(l.defaultProductId) && l.autoDeduct,
        })),
    };
    if (body.lines.some((l) => !Number.isFinite(l.quantity) || l.quantity <= 0)) return setError("Each amount must be a number above 0.");
    if (new Set(body.lines.map((l) => l.inventoryCategoryId)).size !== body.lines.length) return setError("Use each product category once per service.");
    setBusy(true);
    try {
      const r = await apiFetch<ServiceRecipeDto>(`${inventoryBase(salonId)}/${SERVICE_USAGE_PATHS.recipes}/${recipe.serviceId}`, { method: "PUT", body: JSON.stringify(body) });
      setSaved(true);
      onSaved(r);
    } catch (err) {
      setError(errorText(err, "The recipe was not saved — try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={recipe.serviceName} sub={recipe.isActive ? recipe.serviceCategory ?? undefined : "This service is not offered at the moment."}>
      {lines.length === 0 && <p className={ui.cardSub}>No products set up. Barbers won&apos;t be asked which products they used for this service.</p>}
      {lines.map((line, i) => {
        const inCategory = products.filter((p) => p.isActive && p.category?.id === line.inventoryCategoryId && (p.usage ?? "PROFESSIONAL") === "PROFESSIONAL");
        return (
          <div key={i} className={styles.recipeRow}>
            <Field label="Product type" htmlFor={`rc-${recipe.serviceId}-${i}`}>
              <select id={`rc-${recipe.serviceId}-${i}`} className={ui.input} value={line.inventoryCategoryId} onChange={(e) => set(i, { inventoryCategoryId: e.target.value, defaultProductId: "", autoDeduct: false })}>
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id !== line.inventoryCategoryId && used.has(c.id)}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Amount per service" htmlFor={`rq-${recipe.serviceId}-${i}`}>
              <input id={`rq-${recipe.serviceId}-${i}`} className={ui.input} style={{ width: 96 }} inputMode="decimal" value={line.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
            </Field>
            <Field label="Unit" htmlFor={`ru-${recipe.serviceId}-${i}`}>
              <select id={`ru-${recipe.serviceId}-${i}`} className={ui.input} value={line.unit} onChange={(e) => set(i, { unit: e.target.value as InventoryUnit })}>
                {UNIT_OPTIONS.filter((u) => RECIPE_UNITS.includes(u.value as InventoryUnit)).map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Usual product (optional)" htmlFor={`rd-${recipe.serviceId}-${i}`}>
              <select id={`rd-${recipe.serviceId}-${i}`} className={ui.input} value={line.defaultProductId} onChange={(e) => set(i, { defaultProductId: e.target.value, autoDeduct: e.target.value ? line.autoDeduct : false })} disabled={!line.inventoryCategoryId}>
                <option value="">None — barber chooses</option>
                {inCategory.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <label className={ui.label} style={{ alignSelf: "center" }}>
              <input type="checkbox" checked={line.autoDeduct} disabled={!line.defaultProductId} onChange={(e) => set(i, { autoDeduct: e.target.checked })} /> Take it off stock automatically when the service is completed
            </label>
            <Btn small variant="quiet" onClick={() => setLines((all) => all.filter((_, n) => n !== i))}>Remove</Btn>
          </div>
        );
      })}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <Btn small onClick={() => setLines((all) => [...all, { inventoryCategoryId: "", quantity: "1", unit: "EACH", defaultProductId: "", autoDeduct: false }])}>+ Add a product type</Btn>
        {recipe.suggestions
          .filter((name) => !categories.some((c) => used.has(c.id) && c.name.trim().toLowerCase() === name.toLowerCase()))
          .map((name) => (
            <Btn key={name} small variant="quiet" onClick={() => void addSuggestion(name)}>+ {name}</Btn>
          ))}
      </div>
      {lines.some((l) => l.autoDeduct) && <p className={ui.hint}>Automatic deduction only happens when every line of this service has a usual product ticked. Otherwise the barber is asked.</p>}
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      {saved && <div className={ui.mt12} role="status"><Banner tone="ok">Saved.</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <Btn variant="primary" onClick={() => void save()} disabled={busy}>{busy ? "Saving…" : "Save"}</Btn>
      </div>
    </Card>
  );
}

/** Owner: what each service uses ("Shaving: shaving cream 10 ml, 1 blade"), with suggestions for common services. */
export function ServiceRecipesView({ salonId }: { salonId: string }) {
  const recipes = useResource<ServiceRecipeDto[]>(`${inventoryBase(salonId)}/${SERVICE_USAGE_PATHS.recipes}`);
  const [categories, setCategories] = useState<InventoryCategoryDto[]>([]);
  const [products, setProducts] = useState<InventoryProductDto[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const base = inventoryBase(salonId);
    void loadAll<InventoryCategoryDto>(`${base}/${INVENTORY_PATHS.categories}`).then((r) => setCategories(r.items)).catch(() => undefined);
    void loadAll<InventoryProductDto>(`${base}/${INVENTORY_PATHS.products}`).then((r) => setProducts(r.items)).catch(() => undefined);
  }, [salonId]);
  if (recipes.loading) return <div className={ui.mt16}><Skeleton height={160} /></div>;
  if (recipes.error || !recipes.data) return <div className={ui.mt16}><Banner tone="error">{recipes.error} <Btn small onClick={recipes.reload}>Try again</Btn></Banner></div>;
  const shown = recipes.data.filter((r) => r.serviceName.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className={ui.mt16}>
      <Card title="Service recipes" sub="Say which products each service uses and how much. When a service is completed, the barber taps the photos of the products actually used and they are taken off stock.">
        <Field label="Find a service" htmlFor="recipe-search">
          <input id="recipe-search" className={ui.input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </Card>
      {recipes.data.length === 0 && <div className={ui.mt16}><Card><EmptyState title="This shop has no services yet" /></Card></div>}
      {shown.map((r) => (
        <div key={r.serviceId} className={ui.mt16}>
          <RecipeEditor salonId={salonId} recipe={r} categories={categories} products={products} onCategoryCreated={(c) => setCategories((all) => [...all, c])} onSaved={() => undefined} />
        </div>
      ))}
    </div>
  );
}

// ---------- Product usage (visits) ----------

/** Owner: completed visits and the products recorded for them; record missed ones or correct mistakes. */
export function ProductUsageView({ salonId }: { salonId: string }) {
  const [filter, setFilter] = useState<"all" | "missing" | "recorded">("all");
  const visits = useResource<ServiceVisitsDto>(`${inventoryBase(salonId)}/${SERVICE_USAGE_PATHS.visits}?filter=${filter}`);
  const [recordFor, setRecordFor] = useState<string | null>(null);
  const [correct, setCorrect] = useState<UsageRecordDto | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function reverse() {
    if (!correct) return;
    if (reason.trim().length < 3) return setError("Say briefly why (at least 3 characters).");
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${inventoryBase(salonId)}/${SERVICE_USAGE_PATHS.usage}/${correct.id}/${SERVICE_USAGE_PATHS.reverse}`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) });
      setNotice("Stock put back. You can now record the right products.");
      setCorrect(null);
      setReason("");
      visits.reload();
    } catch (err) {
      setError(errorText(err, "The correction was not saved — try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ui.mt16}>
      <Card
        title="Product usage"
        sub={visits.data ? `Completed visits from ${visits.data.range.from} to ${visits.data.range.to}.` : "Completed visits in the last 7 days."}
        action={
          <select aria-label="Show" className={ui.input} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All visits</option>
            <option value="missing">Products not recorded</option>
            <option value="recorded">Products recorded</option>
          </select>
        }
      >
        {visits.data && visits.data.missingCount > 0 && filter !== "missing" && (
          <Banner tone="warn">
            {visits.data.missingCount} visit{visits.data.missingCount === 1 ? "" : "s"} with a recipe have no products recorded. <Btn small onClick={() => setFilter("missing")}>Show them</Btn>
          </Banner>
        )}
        {notice && <div className={ui.mt12} role="status"><Banner tone="ok">{notice}</Banner></div>}
        {visits.loading ? (
          <Skeleton height={120} />
        ) : visits.error ? (
          <Banner tone="error">{visits.error}</Banner>
        ) : visits.data!.items.length === 0 ? (
          <EmptyState title={filter === "missing" ? "Nothing missing" : "No completed visits in this period"} />
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr><th>Visit</th><th>Service</th><th>Products used</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {visits.data!.items.flatMap((v) =>
                  v.services.map((s, i) => (
                    <tr key={`${v.queueEntryId}-${s.serviceId}`}>
                      <td>{i === 0 ? <>#{v.tokenNumber}{v.customerName ? ` ${v.customerName}` : ""}<div className={ui.hint}>{v.completedAt ? formatShopTime(v.completedAt, null) : ""}{v.staffName ? ` · ${v.staffName}` : ""}</div></> : null}</td>
                      <td>{s.serviceName}</td>
                      <td>
                        {s.usage ? (
                          <>
                            {usageText(s.usage)} {s.usage.source === "AUTO" && <Badge tone="info">Automatic</Badge>}
                          </>
                        ) : s.hasRecipe ? (
                          <Badge tone="warn">Not recorded</Badge>
                        ) : (
                          <span className={ui.hint}>No recipe</span>
                        )}
                      </td>
                      <td>
                        {s.usage ? (
                          <Btn small variant="quiet" onClick={() => { setNotice(null); setError(null); setCorrect(s.usage); }}>Correct</Btn>
                        ) : (
                          <Btn small onClick={() => { setNotice(null); setRecordFor(v.queueEntryId); }}>Record</Btn>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {recordFor && (
        <ServiceUsageDialog
          queueEntryId={recordFor}
          mode="record"
          onClose={() => setRecordFor(null)}
          onSaved={(message) => {
            setNotice(message);
            visits.reload();
          }}
        />
      )}
      {correct && (
        <Dialog title="Correct products used" onClose={() => !busy && setCorrect(null)}>
          <p>
            This puts back <strong>{usageText(correct)}</strong> into stock and keeps a record of the correction. Then record the right products.
          </p>
          <Field label="Why?" htmlFor="correct-reason">
            <input id="correct-reason" className={ui.input} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong shade chosen" />
          </Field>
          {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
          <div className={ui.dialogActions}>
            <Btn variant="quiet" onClick={() => setCorrect(null)} disabled={busy}>Cancel</Btn>
            <Btn variant="primary" onClick={() => void reverse()} disabled={busy}>{busy ? "Saving…" : "Put stock back"}</Btn>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ---------- Dashboard ----------

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className={ui.stat}>
      <div className={ui.statLabel}>{label}</div>
      <div className={ui.statValue}>{value}</div>
      {sub && <div className={ui.hint}>{sub}</div>}
    </div>
  );
}

/** Owner: the inventory dashboard — stock, use per day/week/month, use by service, wastage, expiry. */
export function InventoryDashboard({ salonId }: { salonId: string }) {
  const base = `/dashboard/salons/${salonId}/inventory`;
  const { data, error, loading, reload } = useResource<InventoryDashboardDto>(`${inventoryBase(salonId)}/${SERVICE_USAGE_PATHS.dashboard}`);
  // Refresh every minute while the page is open (the server computes everything).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = window.setInterval(reload, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload is a stable intent
  }, []);
  if (loading) return <Skeleton height={160} />;
  if (error || !data) return <Banner tone="error">{error ?? "No dashboard."} <Btn small onClick={reload}>Try again</Btn></Banner>;
  const money = (v: string) => moneyText(v, data.currency);
  const max = Math.max(...data.usageByDay.map((d) => Number(d.value)), 0);
  return (
    <>
      <Card title="Stock today">
        <div className={ui.statGrid}>
          <Stat label="Products in use" value={data.totals.activeProducts} />
          <Stat label="Low on stock" value={data.totals.lowStock} />
          <Stat label="Out of stock" value={data.totals.outOfStock} />
          <Stat label="Expiring within 30 days" value={data.totals.expiringSoon} />
          <Stat label="Stock value (at cost)" value={money(data.totals.stockValue)} />
        </div>
        {data.visitsMissingUsage7Days > 0 && (
          <div className={ui.mt12}>
            <Banner tone="warn">
              {data.visitsMissingUsage7Days} visit{data.visitsMissingUsage7Days === 1 ? "" : "s"} in the last 7 days have no products recorded. <BtnLink small href={`${base}/usage`}>Record them</BtnLink>
            </Banner>
          </div>
        )}
      </Card>
      <div className={ui.mt16}>
        <Card title="Products used (at cost)" sub="What the stock used cost you, at the average cost when it was used.">
          <div className={ui.statGrid}>
            <Stat label="Today" value={money(data.usage.today)} />
            <Stat label="Last 7 days" value={money(data.usage.last7Days)} />
            <Stat label="Last 30 days" value={money(data.usage.last30Days)} />
          </div>
          <div className={styles.bars} role="img" aria-label={`Daily use over 30 days, highest ${money(String(max))}`}>
            {data.usageByDay.map((d) => (
              <div key={d.day} title={`${d.day}: ${money(d.value)}`} className={`${styles.bar} ${Number(d.value) === 0 ? styles.barEmpty : ""}`} style={{ height: `${max > 0 ? Math.max(3, (Number(d.value) / max) * 100) : 3}%` }} />
            ))}
          </div>
          <div className={styles.barAxis}><span>{data.usageByDay[0]?.day}</span><span>{data.asOf}</span></div>
        </Card>
      </div>
      <div className={ui.mt16}>
        <Card title="Last 30 days">
          <div className={ui.statGrid}>
            <Stat label="Bought" value={money(data.purchases30Days.value)} sub={`${data.purchases30Days.entries} entries`} />
            <Stat label="Sold / used from the retail shelf" value={money(data.retailOut30Days.value)} sub={`${data.retailOut30Days.entries} entries, at cost`} />
            <Stat label="Damaged, expired or wasted" value={money(data.wastage30Days.value)} sub={`${data.wastage30Days.entries} entries, at cost`} />
          </div>
        </Card>
      </div>
      <div className={ui.mt16}>
        <Card title="Use by service (30 days)">
          {data.byService30Days.length === 0 ? (
            <EmptyState title="No products recorded for services yet">
              Set up <a href={`${base}/recipes`}>service recipes</a>; barbers then pick the products used when they complete a service.
            </EmptyState>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Service</th><th className={ui.num}>Visits</th><th className={ui.num}>Products used (at cost)</th></tr></thead>
                <tbody>
                  {data.byService30Days.map((s) => (
                    <tr key={s.serviceId}><td>{s.serviceName}</td><td className={ui.num}>{s.visits}</td><td className={ui.num}>{money(s.value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      <div className={ui.mt16}>
        <Card title="Most used products (30 days)">
          {data.topProducts30Days.length === 0 ? (
            <EmptyState title="Nothing used yet" />
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Product</th><th className={ui.num}>Used</th><th className={ui.num}>At cost</th></tr></thead>
                <tbody>
                  {data.topProducts30Days.map((p) => (
                    <tr key={p.productId}><td>{p.name}</td><td className={ui.num}>{quantityText(p.quantity, p.unit)}</td><td className={ui.num}>{money(p.value)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {data.expiring.length > 0 && (
        <div className={ui.mt16}>
          <Card title="Expiring soon" sub="Stock received with an expiry date in the next 30 days (or already past) that is still in stock.">
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <thead><tr><th>Product</th><th>Batch</th><th>Expires</th><th className={ui.num}>In stock</th></tr></thead>
                <tbody>
                  {data.expiring.map((e) => (
                    <tr key={`${e.productId}-${e.batchNumber}-${e.expiryDate}`}><td>{e.name}</td><td>{e.batchNumber ?? "—"}</td><td>{e.expiryDate < data.asOf ? <Badge tone="warn">{e.expiryDate} (past)</Badge> : e.expiryDate}</td><td className={ui.num}>{quantityText(e.stockOnHand, e.unit)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
