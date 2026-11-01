"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { INVENTORY_PATHS } from "@barbercue/shared";
import type { InventoryMovementDto, InventoryProductDto, InventoryReportDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { MOVEMENT_KINDS, kindLabel, moneyText, quantityText, trimDecimal, type MovementKind } from "../../../lib/inventory";
import { useCursorList } from "../../../lib/use-cursor-list";
import { useInventoryCurrency } from "../../../lib/use-inventory-currency";
import { inventoryBase, useInventoryLookups } from "../../../lib/use-inventory-lookups";
import { Banner, Btn, BtnLink, Card, EmptyState, Field, Skeleton } from "../parts";
import { MovementForm } from "./MovementForm";
import { MovementsTable } from "./MovementsTable";
import { ListFooter, ListSkeleton, ProductPicker, StockCell } from "./shared";
import { InventoryDashboard } from "./ServiceUsageViews";
import ui from "../owner.module.css";

const WORKSPACES: Record<"PURCHASE" | "CONSUMPTION" | "ADJUSTMENT", { title: string; sub: string; historyTitle: string }> = {
  PURCHASE: {
    title: "Record a purchase",
    sub: "Stock you bought. Enter what you paid for each unit; the server updates the stock and the average cost.",
    historyTitle: "Recent purchases",
  },
  CONSUMPTION: {
    title: "Record stock used",
    sub: "Stock used up, for example in services. The server refuses it if there is not enough stock.",
    historyTitle: "Recent use",
  },
  ADJUSTMENT: {
    title: "Adjust stock",
    sub: "Correct the record after a count, or for stock that was lost, damaged or expired. A reason is always required.",
    historyTitle: "Recent adjustments",
  },
};

/** Purchases, stock used and adjustments share one flow: a movement form, then the recent entries of that kind from the server. */
export function MovementWorkspace({ salonId, kind }: { salonId: string; kind: "PURCHASE" | "CONSUMPTION" | "ADJUSTMENT" }) {
  const copy = WORKSPACES[kind];
  const lookups = useInventoryLookups(salonId);
  const currency = useInventoryCurrency(salonId);
  const list = useCursorList<InventoryMovementDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.movements}`, { kind });
  return (
    <div className={ui.mt16}>
      <Card title={copy.title} sub={copy.sub}>
        {kind === "PURCHASE" && lookups.error && <Banner tone="warn">{lookups.error} You can still record a purchase without choosing a supplier.</Banner>}
        <MovementForm salonId={salonId} kind={kind} suppliers={lookups.suppliers} onRecorded={() => list.reload()} />
      </Card>
      <div className={ui.mt16}>
        <Card title={copy.historyTitle}>
          {list.loading ? <ListSkeleton /> : <MovementsTable items={list.items} currency={currency} emptyTitle="Nothing recorded yet" />}
          <ListFooter list={list} />
        </Card>
      </div>
    </div>
  );
}

/** Every movement, newest first, filtered by type and product. Entries are shown as recorded and cannot be changed. */
export function HistoryView({ salonId }: { salonId: string }) {
  const [kind, setKind] = useState<MovementKind | "">("");
  const [product, setProduct] = useState<InventoryProductDto | null>(null);
  const currency = useInventoryCurrency(salonId);
  const list = useCursorList<InventoryMovementDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.movements}`, { kind, productId: product?.id ?? "" });
  const filtering = Boolean(kind || product);
  return (
    <div className={ui.mt16}>
      <Card title="Stock history" sub="Every stock change, as recorded. Entries are never edited or deleted; a mistake is corrected with an adjustment.">
        <div className={ui.rowWrap}>
          <Field label="Type" htmlFor="hist-kind">
            <select id="hist-kind" className={ui.input} value={kind} onChange={(e) => setKind(e.target.value as MovementKind | "")}>
              <option value="">All types</option>
              {MOVEMENT_KINDS.map((k) => (
                <option key={k} value={k}>{kindLabel(k)}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className={ui.mt12}>
          <ProductPicker salonId={salonId} value={product} onChange={setProduct} includeInactive label="Only this product (optional)" id="hist-product" />
        </div>
        <div className={ui.mt12}>
          {list.loading ? <ListSkeleton /> : <MovementsTable items={list.items} currency={currency} emptyTitle={filtering ? "No entries match" : "No stock movements yet"} />}
          <ListFooter list={list} />
        </div>
      </Card>
    </div>
  );
}

/** Products the server flags as low on stock, with a way to restock. The flag is the server's, never worked out here. */
export function LowStockView({ salonId }: { salonId: string }) {
  const base = `/dashboard/salons/${salonId}/inventory`;
  const list = useCursorList<InventoryProductDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}`, { lowStock: "true" });
  return (
    <div className={ui.mt16}>
      <Card title="Low stock alerts" sub="Products at or below the level you asked to be warned at. This list only fills in once you have set a warning level on a product.">
        {list.loading ? (
          <ListSkeleton />
        ) : list.items.length === 0 && !list.error ? (
          <EmptyState title="Nothing is low on stock" action={<BtnLink href={`${base}/products`}>Review products</BtnLink>}>
            No product is at or below its warning level right now.
          </EmptyState>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <caption className={ui.cardSub}>Low on stock</caption>
              <thead><tr><th>Product</th><th>Category</th><th className={ui.num}>In stock</th><th className={ui.num}>Warn at</th><th><span className={ui.srOnly}>Actions</span></th></tr></thead>
              <tbody>
                {list.items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}{p.sku ? <span className={ui.cardSub}> ({p.sku})</span> : null}{p.supplier && <div className={ui.cardSub}>Supplier: {p.supplier.name}</div>}</td>
                    <td>{p.category?.name ?? "—"}</td>
                    <td className={ui.num}><StockCell product={p} /></td>
                    <td className={ui.num}>{quantityText(p.reorderThreshold, p.unit)}</td>
                    <td><Link className={ui.cardLink} href={`${base}/purchases`}>Record a purchase</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ListFooter list={list} />
      </Card>
    </div>
  );
}

function useReport(salonId: string) {
  const [report, setReport] = useState<InventoryReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const r = await apiFetch<InventoryReportDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.report}`);
        if (!cancelled) setReport(r);
      } catch (err) {
        if (!cancelled) {
          setReport(null);
          setError(err instanceof ApiError ? err.message : "Could not load the inventory report.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [salonId, version]);
  return { report, error, loading, reload: () => setVersion((v) => v + 1) };
}

const VALUATION_NOTE = "Estimated stock value is what the stock you hold cost you, at the server's weighted average cost. It is not revenue, not money collected and not what it would sell for.";

/** The report cards. Figures are the server's; the value is labelled as an estimate and kept apart from revenue. */
function ReportCards({ report }: { report: InventoryReportDto }) {
  return (
    <>
      <div className={ui.statGrid}>
        <div className={ui.stat}><div className={ui.statLabel}>Products</div><div className={ui.statValue}>{report.productCount}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Low on stock</div><div className={ui.statValue}>{report.lowStockCount}</div></div>
        <div className={ui.stat}><div className={ui.statLabel}>Estimated stock value (at cost)</div><div className={ui.statValue}>{moneyText(report.estimatedStockValue, report.currency)}</div></div>
      </div>
      <p className={ui.cardSub}>{VALUATION_NOTE}</p>
    </>
  );
}

/** A short summary and the way into each task. */
export function OverviewView({ salonId }: { salonId: string }) {
  const base = `/dashboard/salons/${salonId}/inventory`;
  const { report, error, loading, reload } = useReport(salonId);
  const recent = useCursorList<InventoryMovementDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.movements}`, {});
  return (
    <div className={ui.mt16}>
      <Card title="Inventory at a glance">
        {loading ? <Skeleton height={96} /> : error ? <Banner tone="error">{error} <Btn small onClick={reload}>Try again</Btn></Banner> : report && report.productCount === 0 ? (
          <EmptyState title="You have not added any products yet" action={<BtnLink variant="primary" href={`${base}/products`}>Add your first product</BtnLink>}>
            Add the products you keep, then record your opening stock.
          </EmptyState>
        ) : report ? <ReportCards report={report} /> : null}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          <BtnLink href={`${base}/products`}>Products</BtnLink>
          <BtnLink href={`${base}/purchases`}>Record a purchase</BtnLink>
          <BtnLink href={`${base}/consumption`}>Record stock used</BtnLink>
          <BtnLink href={`${base}/adjustments`}>Adjust stock</BtnLink>
          {report && report.lowStockCount > 0 && <BtnLink variant="primary" href={`${base}/low-stock`}>See {report.lowStockCount} low on stock</BtnLink>}
        </div>
      </Card>
      <div className={ui.mt16}>
        <InventoryDashboard salonId={salonId} />
      </div>
      <div className={ui.mt16}>
        <Card title="Latest stock changes" action={<BtnLink small variant="quiet" href={`${base}/history`}>All history</BtnLink>}>
          {recent.loading ? <ListSkeleton /> : <MovementsTable items={recent.items.slice(0, 5)} currency={report?.currency ?? null} emptyTitle="No stock movements yet" />}
        </Card>
      </div>
    </div>
  );
}

/** The inventory report: counts, estimated value with its basis, entries by type, and the low-stock products. */
export function ReportView({ salonId }: { salonId: string }) {
  const { report, error, loading, reload } = useReport(salonId);
  if (loading) return <div className={ui.mt16}><Skeleton height={200} /></div>;
  if (error || !report) return <div className={ui.mt16}><Banner tone="error">{error ?? "No report."} <Btn small onClick={reload}>Try again</Btn></Banner></div>;
  return (
    <div className={ui.mt16}>
      <Card title="Inventory report" sub="Computed by the server from your recorded stock. Nothing here is estimated by this page.">
        <ReportCards report={report} />
        <p className={ui.cardSub}>Basis: {report.valuationBasis === "weighted-average-cost" ? "weighted average cost" : String(report.valuationBasis)}{report.currency ? `, in ${report.currency}` : ", currency not set"}.</p>
      </Card>
      <div className={ui.mt16}>
        <Card title="Entries recorded">
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <caption className={ui.cardSub}>Number of entries by type</caption>
              <thead><tr><th>Type</th><th className={ui.num}>Entries</th></tr></thead>
              <tbody>
                {MOVEMENT_KINDS.map((k) => (
                  <tr key={k}><td>{kindLabel(k)}</td><td className={ui.num}>{report.movementCounts?.[k] ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <div className={ui.mt16}>
        <Card title="Low on stock">
          {report.lowStockProducts.length === 0 ? (
            <EmptyState title="Nothing is low on stock" />
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <caption className={ui.cardSub}>Products at or below their warning level</caption>
                <thead><tr><th>Product</th><th className={ui.num}>In stock</th><th className={ui.num}>Warn at</th></tr></thead>
                <tbody>
                  {report.lowStockProducts.map((p) => (
                    <tr key={p.id}><td>{p.name}</td><td className={ui.num}>{quantityText(p.stockOnHand, p.unit)}</td><td className={ui.num}>{trimDecimal(p.reorderThreshold)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.lowStockCount > report.lowStockProducts.length && <p className={ui.cardSub}>Showing {report.lowStockProducts.length} of {report.lowStockCount}. The Low stock page lists them all.</p>}
        </Card>
      </div>
    </div>
  );
}

