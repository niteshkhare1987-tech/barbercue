"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { INVENTORY_PATHS } from "@barbercue/shared";
import type { InventoryProductDto } from "@barbercue/shared";
import { apiFetch } from "../../../lib/api";
import { inventoryBase } from "../../../lib/use-inventory-lookups";
import { listQuery, quantityText, searchTerm } from "../../../lib/inventory";
import type { CursorPage, CursorListState } from "../../../lib/use-cursor-list";
import { Badge, Banner, Btn, Skeleton } from "../parts";
import ui from "../owner.module.css";

export const INVENTORY_SECTIONS: ReadonlyArray<{ path: string; label: string }> = [
  { path: "", label: "Overview" },
  { path: "scan", label: "Scan / Add stock" },
  { path: "products", label: "Products" },
  { path: "categories", label: "Categories" },
  { path: "suppliers", label: "Suppliers" },
  { path: "purchases", label: "Purchases" },
  { path: "consumption", label: "Stock used" },
  { path: "adjustments", label: "Adjustments" },
  { path: "low-stock", label: "Low stock" },
  { path: "history", label: "Stock history" },
  { path: "reports", label: "Reports" },
];

/** Links between the inventory pages. The current page is marked; the row scrolls sideways on a narrow screen. */
export function InventoryTabs({ salonId }: { salonId: string }) {
  const pathname = usePathname() ?? "";
  const root = `/dashboard/salons/${salonId}/inventory`;
  return (
    <nav aria-label="Inventory sections" className={ui.tabs} style={{ overflowX: "auto", flexWrap: "nowrap" }}>
      {INVENTORY_SECTIONS.map((s) => {
        const href = s.path ? `${root}/${s.path}` : root;
        const active = s.path ? pathname === href || pathname.startsWith(`${href}/`) : pathname === root;
        return (
          <Link key={s.path || "overview"} href={href} className={`${ui.tab} ${active ? ui.tabActive : ""}`} aria-current={active ? "page" : undefined} style={{ whiteSpace: "nowrap" }}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The "load more" row and the error / notice lines under a paged list. */
export function ListFooter<T>({ list }: { list: CursorListState<T> }) {
  return (
    <>
      {list.error && <div className={ui.mt12}><Banner tone="error">{list.error} <Btn small onClick={list.reload}>Try again</Btn></Banner></div>}
      {list.notice && <div className={ui.mt12} role="status"><Banner tone="info">{list.notice}</Banner></div>}
      {list.hasMore && (
        <div className={ui.mt12}>
          <Btn onClick={list.loadMore} disabled={list.loadingMore}>{list.loadingMore ? "Loading…" : "Load more"}</Btn>
        </div>
      )}
    </>
  );
}

export function ListSkeleton() {
  return <Skeleton height={120} />;
}

/** Stock text and the server's own low-stock flag. The flag is never worked out here. */
export function StockCell({ product }: { product: InventoryProductDto }) {
  return (
    <>
      {quantityText(product.stockOnHand, product.unit)}{" "}
      {product.isLowStock && <Badge tone="warn">Low</Badge>}
    </>
  );
}

/**
 * Finds a product by typing part of its name or SKU (searched on the server) and choosing from the results. Nothing is
 * chosen until the owner picks a row, and the chosen product is shown with the server's current stock.
 */
export function ProductPicker({
  salonId,
  value,
  onChange,
  includeInactive = false,
  label = "Product",
  id = "product-picker",
}: {
  salonId: string;
  value: InventoryProductDto | null;
  onChange: (product: InventoryProductDto | null) => void;
  includeInactive?: boolean;
  label?: string;
  id?: string;
}) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<InventoryProductDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [term, setTerm] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setTerm(searchTerm(text)), 350);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (value) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const page = await apiFetch<CursorPage<InventoryProductDto>>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}?${listQuery({ q: term }, null, 10)}`);
        if (!cancelled) setResults(includeInactive ? page.items : page.items.filter((p) => p.isActive));
      } catch {
        if (!cancelled) {
          setResults([]);
          setError("Could not search products.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [salonId, term, value, includeInactive]);

  if (value) {
    return (
      <div role="group" aria-label={label}>
        <div className={ui.label}>{label}</div>
        <p>
          <strong>{value.name}</strong>
          {value.sku ? ` (${value.sku})` : ""} · in stock now: {quantityText(value.stockOnHand, value.unit)}
        </p>
        <Btn small variant="quiet" onClick={() => onChange(null)}>Choose a different product</Btn>
      </div>
    );
  }
  return (
    <div role="group" aria-label={label}>
      <label className={ui.label} htmlFor={id}>{label}</label>
      <input id={id} type="search" className={ui.input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type part of a name or SKU" autoComplete="off" />
      {error && <Banner tone="error">{error}</Banner>}
      {loading && <p className={ui.cardSub}>Searching…</p>}
      {!loading && !error && results.length === 0 && <p className={ui.cardSub}>{term ? "No product matches." : "You have no products yet. Add one on the Products page."}</p>}
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }} aria-label="Matching products">
        {results.map((p) => (
          <li key={p.id}>
            <Btn small variant="quiet" onClick={() => onChange(p)}>
              {p.name}{p.sku ? ` (${p.sku})` : ""} · {quantityText(p.stockOnHand, p.unit)}
            </Btn>
          </li>
        ))}
      </ul>
    </div>
  );
}
