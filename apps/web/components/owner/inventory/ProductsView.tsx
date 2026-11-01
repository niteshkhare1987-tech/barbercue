"use client";

import { useEffect, useState } from "react";
import { INVENTORY_PATHS } from "@barbercue/shared";
import type { InventoryProductDto } from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import {
  COUNTED_UNITS,
  EMPTY_PRODUCT,
  UNIT_OPTIONS,
  buildCreateProduct,
  buildProductPatch,
  entityErrorText,
  moneyText,
  productFormFrom,
  quantityText,
  searchTerm,
  unitShort,
  type ProductErrors,
  type ProductForm,
} from "../../../lib/inventory";
import { useCursorList } from "../../../lib/use-cursor-list";
import { useInventoryCurrency } from "../../../lib/use-inventory-currency";
import { inventoryBase, useInventoryLookups } from "../../../lib/use-inventory-lookups";
import { Badge, Banner, Btn, Card, Dialog, EmptyState, Field } from "../parts";
import { MovementForm } from "./MovementForm";
import { ListFooter, ListSkeleton, StockCell } from "./shared";
import ui from "../owner.module.css";

type Editing = { mode: "create" } | { mode: "edit"; product: InventoryProductDto } | null;

function ProductDialog({
  salonId,
  editing,
  categories,
  suppliers,
  onClose,
  onSaved,
}: {
  salonId: string;
  editing: NonNullable<Editing>;
  categories: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const original = editing.mode === "edit" ? editing.product : null;
  const [form, setForm] = useState<ProductForm>(original ? productFormFrom(original) : EMPTY_PRODUCT);
  const [errors, setErrors] = useState<ProductErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ProductForm>) => setForm((f) => ({ ...f, ...patch }));

  async function save() {
    setError(null);
    const base = `${inventoryBase(salonId)}/${INVENTORY_PATHS.products}`;
    if (original) {
      const { body, errors: found, changed } = buildProductPatch(original, form);
      setErrors(found);
      if (Object.keys(found).length > 0) return;
      if (!changed || !body) {
        setError("Nothing was changed.");
        return;
      }
      setSaving(true);
      try {
        await apiFetch<InventoryProductDto>(`${base}/${original.id}`, { method: "PATCH", body: JSON.stringify(body) });
        onSaved();
      } catch (err) {
        setError(err instanceof ApiError ? entityErrorText(err.code, err.message) : "Could not save. Nothing was changed.");
      } finally {
        setSaving(false);
      }
      return;
    }
    const { body, errors: found } = buildCreateProduct(form);
    setErrors(found);
    if (!body) return;
    setSaving(true);
    try {
      await apiFetch<InventoryProductDto>(base, { method: "POST", body: JSON.stringify(body) });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? entityErrorText(err.code, err.message) : "Could not save. Nothing was added.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={original ? `Edit ${original.name}` : "Add a product"} onClose={() => !saving && onClose()}>
      <div className={ui.rowWrap}>
        <Field label="Name" htmlFor="prod-name" hint={errors.name}>
          <input id="prod-name" className={ui.input} maxLength={120} value={form.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={Boolean(errors.name)} autoComplete="off" />
        </Field>
        <Field label="SKU or code (optional)" htmlFor="prod-sku" hint={errors.sku}>
          <input id="prod-sku" className={ui.input} maxLength={80} value={form.sku} onChange={(e) => set({ sku: e.target.value })} autoComplete="off" />
        </Field>
      </div>
      <div className={ui.rowWrap}>
        <Field label="Unit" htmlFor="prod-unit" hint={original ? "The unit cannot be changed once a product exists." : errors.unit}>
          <select id="prod-unit" className={ui.input} value={form.unit} onChange={(e) => set({ unit: e.target.value })} disabled={Boolean(original)}>
            {UNIT_OPTIONS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Warn me when stock is at or below" htmlFor="prod-threshold" hint={errors.reorderThreshold ?? `In ${unitShort(form.unit)}. Leave empty for no warning.`}>
          <input id="prod-threshold" className={ui.input} inputMode="decimal" value={form.reorderThreshold} onChange={(e) => set({ reorderThreshold: e.target.value })} aria-invalid={Boolean(errors.reorderThreshold)} autoComplete="off" />
        </Field>
      </div>
      {COUNTED_UNITS.includes(original?.unit ?? form.unit) && (
        <div className={ui.rowWrap}>
          <Field label={`One ${unitShort(original?.unit ?? form.unit)} contains (optional)`} htmlFor="prod-content" hint={errors.contentSize ?? "For example 195 ml for a bottle. Lets service recipes in ml or g be taken off stock."}>
            <input id="prod-content" className={ui.input} inputMode="decimal" value={form.contentSize} onChange={(e) => set({ contentSize: e.target.value })} aria-invalid={Boolean(errors.contentSize)} autoComplete="off" />
          </Field>
          <Field label="Contents unit" htmlFor="prod-content-unit">
            <select id="prod-content-unit" className={ui.input} value={form.contentUnit} onChange={(e) => set({ contentUnit: e.target.value })}>
              <option value="">—</option>
              {UNIT_OPTIONS.filter((u) => ["MILLILITER", "LITER", "GRAM", "KILOGRAM", "EACH"].includes(u.value)).map((u) => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className={ui.rowWrap}>
        <Field label="Category (optional)" htmlFor="prod-category">
          <select id="prod-category" className={ui.input} value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Usual supplier (optional)" htmlFor="prod-supplier">
          <select id="prod-supplier" className={ui.input} value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
            <option value="">No supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
      </div>
      {original && (
        <label className={ui.label}>
          <input id="prod-active" type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> In use (untick to stop using this product; its history stays)
        </label>
      )}
      {!original && <p className={ui.cardSub}>Stock is added afterwards as opening stock or a purchase. A product cannot be given a stock figure here.</p>}
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div className={`${ui.rowWrap} ${ui.mt12}`}>
        <Btn variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : original ? "Save changes" : "Add product"}</Btn>
        <Btn variant="quiet" onClick={onClose} disabled={saving}>Cancel</Btn>
      </div>
    </Dialog>
  );
}

/**
 * Products: search, category and low-stock filters, add and edit, opening stock, and stopping or resuming use of a product.
 * Stock, average cost and the low-stock flag are the server's. There is no delete: a product that is no longer used is marked
 * not in use and its history is kept.
 */
export function ProductsView({ salonId }: { salonId: string }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [openingFor, setOpeningFor] = useState<InventoryProductDto | null>(null);
  const [toggling, setToggling] = useState<InventoryProductDto | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(searchTerm(text)), 350);
    return () => clearTimeout(t);
  }, [text]);

  const lookups = useInventoryLookups(salonId);
  const currency = useInventoryCurrency(salonId);
  const list = useCursorList<InventoryProductDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}`, { q: term, categoryId, lowStock: lowOnly ? "true" : "" });
  const filtering = Boolean(term || categoryId || lowOnly);

  async function confirmToggle() {
    if (!toggling) return;
    setToggleBusy(true);
    setToggleError(null);
    try {
      await apiFetch<InventoryProductDto>(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}/${toggling.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !toggling.isActive }) });
      setNotice(toggling.isActive ? `${toggling.name} is no longer in use. Its history is kept.` : `${toggling.name} is in use again.`);
      setToggling(null);
      list.reload();
    } catch (err) {
      setToggleError(err instanceof ApiError ? entityErrorText(err.code, err.message) : "Could not save. Nothing was changed.");
    } finally {
      setToggleBusy(false);
    }
  }

  return (
    <div className={ui.mt16}>
      <Card
        title="Products"
        sub="Everything you keep in stock. Stock levels come from recorded purchases, use and adjustments, never from typing a number here."
        action={<Btn variant="primary" icon="plus" onClick={() => setEditing({ mode: "create" })}>Add product</Btn>}
      >
        <div className={ui.rowWrap}>
          <Field label="Search" htmlFor="prod-search">
            <input id="prod-search" type="search" className={ui.input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Name or SKU" autoComplete="off" />
          </Field>
          <Field label="Category" htmlFor="prod-filter-category">
            <select id="prod-filter-category" className={ui.input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">All categories</option>
              {lookups.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <label className={ui.label}>
          <input id="prod-low" type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Show only products that are low on stock
        </label>
        {lookups.error && <div className={ui.mt12}><Banner tone="warn">{lookups.error} Filters and pickers may be incomplete.</Banner></div>}
        {!lookups.complete && <div className={ui.mt12}><Banner tone="info">You have more categories or suppliers than can be listed here, so some are missing from the pickers.</Banner></div>}
        <div role="status" aria-live="polite">{notice && <div className={ui.mt12}><Banner tone="ok">{notice}</Banner></div>}</div>

        <div className={ui.mt12}>
          {list.loading ? (
            <ListSkeleton />
          ) : list.items.length === 0 && !list.error ? (
            <EmptyState title={filtering ? "No product matches" : "You have no products yet"} action={!filtering ? <Btn variant="primary" onClick={() => setEditing({ mode: "create" })}>Add your first product</Btn> : undefined}>
              {filtering ? "Try a different search or clear the filters." : "Add what you use or sell, then record how much you have."}
            </EmptyState>
          ) : (
            <div className={ui.tableWrap}>
              <table className={ui.table}>
                <caption className={ui.cardSub}>Stock as recorded</caption>
                <thead>
                  <tr><th>Product</th><th>Category</th><th className={ui.num}>In stock</th><th className={ui.num}>Warn at</th><th className={ui.num}>Average cost</th><th><span className={ui.srOnly}>Actions</span></th></tr>
                </thead>
                <tbody>
                  {list.items.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {p.name}{p.sku ? <span className={ui.cardSub}> ({p.sku})</span> : null}{" "}
                        {!p.isActive && <Badge tone="neutral">Not in use</Badge>}
                        {p.supplier && <div className={ui.cardSub}>Supplier: {p.supplier.name}</div>}
                        {(p.barcode || p.globalProductId) && (
                          <div className={ui.cardSub}>
                            {p.usage === "RETAIL" ? "Sold to customers" : "Used on services"}
                            {p.barcode ? ` · Barcode ${p.barcode}` : ""}
                            {p.sellingPrice ? ` · Sells at ₹${Number(p.sellingPrice)}` : ""}
                          </div>
                        )}
                      </td>
                      <td>{p.category?.name ?? "—"}</td>
                      <td className={ui.num}><StockCell product={p} /></td>
                      <td className={ui.num}>{Number(p.reorderThreshold) > 0 ? quantityText(p.reorderThreshold, p.unit) : "—"}</td>
                      <td className={ui.num}>{Number(p.stockOnHand) > 0 || Number(p.averageUnitCost) > 0 ? `${moneyText(p.averageUnitCost, currency)} / ${unitShort(p.unit)}` : "—"}</td>
                      <td>
                        <span className={ui.rowWrap}>
                          <Btn small variant="quiet" onClick={() => setEditing({ mode: "edit", product: p })} aria-label={`Edit ${p.name}`}>Edit</Btn>
                          <Btn small variant="quiet" onClick={() => setOpeningFor(p)} aria-label={`Record opening stock for ${p.name}`}>Opening stock</Btn>
                          <Btn small variant="quiet" onClick={() => { setToggleError(null); setToggling(p); }} aria-label={`${p.isActive ? "Stop using" : "Use again"} ${p.name}`}>{p.isActive ? "Stop using" : "Use again"}</Btn>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <ListFooter list={list} />
          {list.items.length > 0 && <p className={ui.cardSub}>Average cost is the server&apos;s weighted average of what you paid. It is an estimate of cost, not a selling price and not revenue.</p>}
        </div>
      </Card>

      {editing && (
        <ProductDialog
          salonId={salonId}
          editing={editing}
          categories={lookups.categories}
          suppliers={lookups.suppliers}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setNotice(editing.mode === "edit" ? "Changes saved." : "Product added.");
            setEditing(null);
            list.reload();
          }}
        />
      )}

      {openingFor && (
        <Dialog title={`Opening stock: ${openingFor.name}`} onClose={() => setOpeningFor(null)} wide>
          <MovementForm salonId={salonId} kind="OPENING" fixedProduct={openingFor} onRecorded={() => list.reload()} />
          <div className={ui.mt12}><Btn variant="quiet" onClick={() => setOpeningFor(null)}>Close</Btn></div>
        </Dialog>
      )}

      {toggling && (
        <Dialog title={toggling.isActive ? `Stop using ${toggling.name}?` : `Use ${toggling.name} again?`} onClose={() => !toggleBusy && setToggling(null)}>
          <p>
            {toggling.isActive
              ? `It will be marked "Not in use". Its stock (${quantityText(toggling.stockOnHand, toggling.unit)}) and its history are kept, and nothing is deleted.`
              : "It will be marked as in use again."}
          </p>
          {toggleError && <Banner tone="error">{toggleError}</Banner>}
          <div className={`${ui.rowWrap} ${ui.mt12}`}>
            <Btn variant={toggling.isActive ? "danger" : "primary"} onClick={() => void confirmToggle()} disabled={toggleBusy}>{toggleBusy ? "Saving…" : toggling.isActive ? "Stop using" : "Use again"}</Btn>
            <Btn variant="quiet" onClick={() => setToggling(null)} disabled={toggleBusy}>Cancel</Btn>
          </div>
        </Dialog>
      )}
    </div>
  );
}

