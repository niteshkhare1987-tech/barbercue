"use client";

import { useRef, useState } from "react";
import {
  CATALOG_PATHS,
  INVENTORY_LOSS_KINDS,
  INVENTORY_PATHS,
  type CatalogLookupResultDto,
  type CatalogProductDto,
  type ExternalProductSuggestionDto,
  type InventoryMovementDto,
  type InventoryProductDto,
  type InventoryUnit,
  type ProductType,
  type StockUsage,
} from "@barbercue/shared";
import { apiFetch, ApiError } from "../../../lib/api";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { KIND_LABEL, UNIT_OPTIONS, quantityText, unitShort } from "../../../lib/inventory";
import { inventoryBase, useInventoryLookups } from "../../../lib/use-inventory-lookups";
import { parsePackagingText } from "../../../lib/product-scan";
import { Badge, Banner, Btn, Card, Field } from "../parts";
import ui from "../owner.module.css";
import { BarcodeScanner } from "./BarcodeScanner";
import styles from "./scan.module.css";

type Lookup = CatalogLookupResultDto & { hint?: "UPC_E" };

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message || fallback : fallback);
const num = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(/[₹,\s]/g, "")));
const SHELF_LABEL: Record<StockUsage, string> = { PROFESSIONAL: "Used on services", RETAIL: "Sold to customers" };

/**
 * Inventory Phase 1: Scan / Add stock. Scan (camera, photo, USB scanner or typing) → look the
 * barcode up in the FastQue Global Product Master → see the product → enter quantity and prices →
 * stock goes up through the normal ledger. Unknown products are added with packaging photos
 * (text read on this device can prefill the form; the owner confirms everything).
 */
export function ScanAddStock({ salonId }: { salonId: string }) {
  const base = inventoryBase(salonId);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function find(code: string, hint?: "UPC_E") {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const params = new URLSearchParams({ barcode: code, ...(hint ? { hint } : {}) });
      const result = await apiFetch<CatalogLookupResultDto>(`${base}/${CATALOG_PATHS.catalog}/${CATALOG_PATHS.lookup}?${params}`);
      setLookup({ ...result, hint });
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setLookup(null);
      setError(errorText(err, "Could not look that barcode up. Check your connection and try again."));
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    setLookup(null);
    setError(null);
  };

  return (
    <div className={ui.mt16}>
      <Card title="Scan a product" sub="Scan the barcode on the pack to find it in the FastQue product catalog, then add the stock you received.">
        <BarcodeScanner onDetected={(code, hint) => void find(code, hint)} busy={busy} />
      </Card>

      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div role="status" aria-live="polite">{done && <div className={ui.mt12}><Banner tone="ok">{done}</Banner></div>}</div>

      <div ref={resultRef}>
        {lookup && (lookup.status === "FOUND" || lookup.status === "FOUND_PENDING") && lookup.product && (
          <div className={ui.mt16}>
            <ProductCard product={lookup.product} stock={lookup.salonStock} />
            <ReceiveForm
              key={lookup.product.id}
              salonId={salonId}
              catalogProductId={lookup.product.id}
              needsName={false}
              onDone={(text) => { setDone(text); reset(); }}
            />
            {lookup.salonStock.length > 0 && <WriteOffForm salonId={salonId} stock={lookup.salonStock} onDone={(text) => { setDone(text); reset(); }} />}
          </div>
        )}

        {lookup?.status === "PENDING_ELSEWHERE" && lookup.pendingProductId && (
          <div className={ui.mt16}>
            <Banner tone="info">
              Barcode {lookup.barcode.display} was added by another salon and is waiting for FastQue to check it. You can still add it to your stock under your own product name.
            </Banner>
            <ReceiveForm salonId={salonId} catalogProductId={lookup.pendingProductId} needsName onDone={(text) => { setDone(text); reset(); }} />
          </div>
        )}

        {lookup && (lookup.status === "NOT_FOUND" || lookup.status === "EXTERNAL") && (
          <NewProductForm
            salonId={salonId}
            barcode={lookup.barcode.display}
            hint={lookup.hint}
            suggestion={lookup.suggestion}
            onCreated={(product) => setLookup({ ...lookup, status: "FOUND_PENDING", product, suggestion: null })}
          />
        )}
      </div>
    </div>
  );
}

function ProductCard({ product, stock }: { product: CatalogProductDto; stock: CatalogLookupResultDto["salonStock"] }) {
  return (
    <Card tight>
      <div className={styles.product}>
        <div className={styles.productImage}>
          {product.imageUrls[0] ? (
            // eslint-disable-next-line @next/next/no-img-element -- catalog photos are arbitrary owner/admin URLs
            <img src={product.imageUrls[0]} alt={product.name} />
          ) : (
            <span aria-hidden="true">📦</span>
          )}
        </div>
        <div>
          <div className={ui.rowWrap}>
            <strong className={styles.productName}>{product.name}</strong>
            {product.verificationStatus === "VERIFIED" ? <Badge tone="ok">Verified</Badge> : <Badge tone="warn">Waiting for FastQue review</Badge>}
          </div>
          <p className={ui.hint}>
            {[product.brand, product.packSize && product.packUnit ? quantityText(product.packSize, product.packUnit) : null, product.mrp ? `MRP ₹${Number(product.mrp)}` : null, `Barcode ${product.barcodes[0]?.display ?? ""}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className={ui.hint}>
            {stock.length === 0
              ? "Not in your stock yet."
              : stock.map((s) => `${SHELF_LABEL[s.usage]}: ${quantityText(s.stockOnHand, s.unit)}`).join(" · ")}
          </p>
        </div>
      </div>
    </Card>
  );
}

function ReceiveForm({
  salonId,
  catalogProductId,
  needsName,
  onDone,
}: {
  salonId: string;
  catalogProductId: string;
  needsName: boolean;
  onDone: (text: string) => void;
}) {
  const lookups = useInventoryLookups(salonId);
  const keyRef = useRef(newIdempotencyKey());
  const [form, setForm] = useState({
    name: "", // Stock is counted in packs/pieces by default; the pack size (e.g. 100 g) describes one piece.
    usage: "PROFESSIONAL" as StockUsage, unit: "EACH" as InventoryUnit, quantity: "", unitCost: "",
    sellingPrice: "", supplierId: "", batchNumber: "", expiryDate: "", storageLocation: "", reorderThreshold: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const quantity = num(form.quantity);
    const unitCost = num(form.unitCost);
    if (needsName && !form.name.trim()) return setError("Enter the product name you use in your shop.");
    if (!quantity || quantity <= 0) return setError("Enter how many you received.");
    if (unitCost === null || unitCost < 0 || Number.isNaN(unitCost)) return setError("Enter the price you paid for one unit.");
    const sellingPrice = num(form.sellingPrice);
    const reorder = num(form.reorderThreshold);
    if ([sellingPrice, reorder].some((v) => v !== null && (Number.isNaN(v) || v < 0))) return setError("Prices and the reorder level must be numbers.");
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ product: InventoryProductDto; movement: InventoryMovementDto }>(`${inventoryBase(salonId)}/${CATALOG_PATHS.receive}`, {
        method: "POST",
        headers: { "Idempotency-Key": keyRef.current },
        body: JSON.stringify({
          globalProductId: catalogProductId,
          ...(needsName ? { name: form.name.trim() } : {}),
          usage: form.usage,
          unit: form.unit,
          quantity: Math.round(quantity * 1000) / 1000,
          unitCost: Math.round(unitCost * 100) / 100,
          ...(sellingPrice !== null ? { sellingPrice: Math.round(sellingPrice * 100) / 100 } : {}),
          ...(form.supplierId ? { supplierId: form.supplierId } : {}),
          ...(form.batchNumber.trim() ? { batchNumber: form.batchNumber.trim() } : {}),
          ...(form.expiryDate ? { expiryDate: form.expiryDate } : {}),
          ...(form.storageLocation.trim() ? { storageLocation: form.storageLocation.trim() } : {}),
          ...(reorder !== null ? { reorderThreshold: reorder } : {}),
        }),
      });
      keyRef.current = newIdempotencyKey();
      onDone(`Added ${quantityText(String(quantity), result.product.unit)} of ${result.product.name} (${SHELF_LABEL[form.usage].toLowerCase()}). You now have ${quantityText(result.product.stockOnHand, result.product.unit)}.`);
    } catch (err) {
      setError(errorText(err, "The stock was not added. Nothing changed — try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add stock" sub="Stock goes up as a recorded entry in your stock history.">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {needsName && (
          <Field label="Product name in your shop" htmlFor="recv-name">
            <input id="recv-name" className={ui.input} value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
          </Field>
        )}
        <div className={styles.shelves} role="radiogroup" aria-label="Which stock is this">
          {(Object.keys(SHELF_LABEL) as StockUsage[]).map((usage) => (
            <button key={usage} type="button" role="radio" aria-checked={form.usage === usage} className={`${styles.shelf} ${form.usage === usage ? styles.shelfOn : ""}`} onClick={() => set({ usage })}>
              {SHELF_LABEL[usage]}
            </button>
          ))}
        </div>
        <div className={ui.rowWrap}>
          <Field label="Quantity received" htmlFor="recv-qty">
            <input id="recv-qty" className={ui.input} inputMode="decimal" value={form.quantity} onChange={(e) => set({ quantity: e.target.value })} />
          </Field>
          <Field label="Unit" htmlFor="recv-unit">
            <select id="recv-unit" className={ui.input} value={form.unit} onChange={(e) => set({ unit: e.target.value as InventoryUnit })}>
              {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </Field>
          <Field label="Price paid per unit (₹)" htmlFor="recv-cost">
            <input id="recv-cost" className={ui.input} inputMode="decimal" value={form.unitCost} onChange={(e) => set({ unitCost: e.target.value })} />
          </Field>
          <Field label="Selling price (₹, optional)" htmlFor="recv-sell">
            <input id="recv-sell" className={ui.input} inputMode="decimal" value={form.sellingPrice} onChange={(e) => set({ sellingPrice: e.target.value })} />
          </Field>
        </div>
        <div className={ui.rowWrap}>
          <Field label="Supplier (optional)" htmlFor="recv-supplier">
            <select id="recv-supplier" className={ui.input} value={form.supplierId} onChange={(e) => set({ supplierId: e.target.value })}>
              <option value="">—</option>
              {lookups.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Batch / lot (optional)" htmlFor="recv-batch">
            <input id="recv-batch" className={ui.input} maxLength={60} value={form.batchNumber} onChange={(e) => set({ batchNumber: e.target.value })} />
          </Field>
          <Field label="Expiry date (optional)" htmlFor="recv-exp">
            <input id="recv-exp" type="date" className={ui.input} value={form.expiryDate} onChange={(e) => set({ expiryDate: e.target.value })} />
          </Field>
          <Field label="Storage place (optional)" htmlFor="recv-loc">
            <input id="recv-loc" className={ui.input} maxLength={80} value={form.storageLocation} onChange={(e) => set({ storageLocation: e.target.value })} placeholder="e.g. Back shelf" />
          </Field>
          <Field label="Reorder when below (optional)" htmlFor="recv-reorder">
            <input id="recv-reorder" className={ui.input} inputMode="decimal" value={form.reorderThreshold} onChange={(e) => set({ reorderThreshold: e.target.value })} />
          </Field>
        </div>
        {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          <Btn type="submit" variant="primary" disabled={busy}>{busy ? "Adding…" : "Add to stock"}</Btn>
        </div>
      </form>
    </Card>
  );
}

function WriteOffForm({ salonId, stock, onDone }: { salonId: string; stock: CatalogLookupResultDto["salonStock"]; onDone: (text: string) => void }) {
  const keyRef = useRef(newIdempotencyKey());
  const [productId, setProductId] = useState(stock[0].inventoryProductId);
  const [kind, setKind] = useState<(typeof INVENTORY_LOSS_KINDS)[number]>("DAMAGE");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = stock.find((s) => s.inventoryProductId === productId) ?? stock[0];

  async function submit() {
    const q = num(quantity);
    if (!q || q <= 0) return setError("Enter how much to remove.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${inventoryBase(salonId)}/${INVENTORY_PATHS.products}/${productId}/${INVENTORY_PATHS.movements}`, {
        method: "POST",
        headers: { "Idempotency-Key": keyRef.current },
        body: JSON.stringify({ kind, quantity: Math.round(q * 1000) / 1000, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      });
      keyRef.current = newIdempotencyKey();
      onDone(`Recorded ${quantityText(String(q), chosen.unit)} as ${KIND_LABEL[kind].toLowerCase()}.`);
    } catch (err) {
      setError(errorText(err, "Nothing was recorded — try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={`${ui.card} ${ui.mt12}`}>
      <summary className={styles.summary}>Remove damaged, expired or returned stock</summary>
      <div className={ui.rowWrap}>
        {stock.length > 1 && (
          <Field label="From" htmlFor="loss-shelf">
            <select id="loss-shelf" className={ui.input} value={productId} onChange={(e) => setProductId(e.target.value)}>
              {stock.map((s) => <option key={s.inventoryProductId} value={s.inventoryProductId}>{SHELF_LABEL[s.usage]} ({quantityText(s.stockOnHand, s.unit)})</option>)}
            </select>
          </Field>
        )}
        <Field label="Why" htmlFor="loss-kind">
          <select id="loss-kind" className={ui.input} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {INVENTORY_LOSS_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label={`Quantity (${unitShort(chosen.unit)})`} htmlFor="loss-qty">
          <input id="loss-qty" className={ui.input} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field label="Note (optional)" htmlFor="loss-note">
          <input id="loss-note" className={ui.input} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
      <div className={ui.mt12}><Btn onClick={() => void submit()} disabled={busy}>{busy ? "Saving…" : "Remove from stock"}</Btn></div>
    </details>
  );
}

function NewProductForm({
  salonId,
  barcode,
  hint,
  suggestion,
  onCreated,
}: {
  salonId: string;
  barcode: string;
  hint?: "UPC_E";
  suggestion: ExternalProductSuggestionDto | null;
  onCreated: (product: CatalogProductDto) => void;
}) {
  const sizeGuess = suggestion?.packSizeText ? parsePackagingText(suggestion.packSizeText) : null;
  const [form, setForm] = useState({
    name: suggestion?.name ?? "", brand: suggestion?.brand ?? "", category: suggestion?.category ?? "",
    packSize: sizeGuess?.packSize ? String(sizeGuess.packSize) : "", packUnit: (sizeGuess?.packUnit ?? "") as InventoryUnit | "",
    mrp: "", productType: "BOTH" as ProductType,
  });
  const [photos, setPhotos] = useState<string[]>(suggestion?.imageUrl ? [suggestion.imageUrl] : []);
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function addPhoto(file: File | undefined) {
    if (!file || photos.length >= 4) return;
    setError(null);
    const body = new FormData();
    body.append("image", file);
    try {
      const { url } = await apiFetch<{ url: string }>(`${inventoryBase(salonId)}/${CATALOG_PATHS.catalog}/${CATALOG_PATHS.images}`, { method: "POST", body });
      setPhotos((p) => [...p, url]);
      setFiles((f) => [...f, file]);
    } catch (err) {
      setError(errorText(err, "That photo could not be uploaded."));
    }
  }

  /** On-device text reading (Tesseract runs in this browser; the photo is not sent anywhere for this). */
  async function readPhotos() {
    if (!files.length) return;
    setReading(true);
    setReadNote(null);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker(["eng"], 1);
      let text = "";
      for (const file of files) text += `${(await worker.recognize(file)).data.text}\n`;
      await worker.terminate();
      const guess = parsePackagingText(text);
      set({
        ...(guess.name && !form.name ? { name: guess.name } : {}),
        ...(guess.brand && !form.brand ? { brand: guess.brand } : {}),
        ...(guess.packSize && !form.packSize ? { packSize: String(guess.packSize) } : {}),
        ...(guess.packUnit && !form.packUnit ? { packUnit: guess.packUnit } : {}),
        ...(guess.mrp && !form.mrp ? { mrp: String(guess.mrp) } : {}),
      });
      setReadNote("Filled in what could be read from the photos. Check every field before saving.");
    } catch {
      setReadNote("The text on the photos could not be read. Type the details instead.");
    } finally {
      setReading(false);
    }
  }

  async function submit() {
    if (!form.name.trim()) return setError("Enter the product name.");
    const packSize = num(form.packSize);
    const mrp = num(form.mrp);
    if ([packSize, mrp].some((v) => v !== null && (Number.isNaN(v) || v <= 0))) return setError("Pack size and MRP must be numbers above 0.");
    setBusy(true);
    setError(null);
    try {
      const product = await apiFetch<CatalogProductDto>(`${inventoryBase(salonId)}/${CATALOG_PATHS.catalog}/${CATALOG_PATHS.products}`, {
        method: "POST",
        body: JSON.stringify({
          barcode,
          ...(hint ? { barcodeHint: hint } : {}),
          name: form.name.trim(),
          brand: form.brand.trim() || null,
          category: form.category.trim() || null,
          packSize,
          packUnit: form.packUnit || null,
          mrp,
          productType: form.productType,
          dataSource: suggestion ? "OPEN_BEAUTY_FACTS" : "SALON_SUBMITTED",
          ...(suggestion ? { sourceReference: suggestion.sourceUrl } : {}),
          imageUrls: photos,
        }),
      });
      onCreated(product);
    } catch (err) {
      setError(errorText(err, "The product was not saved — try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={ui.mt16}>
      <Card
        title="New product"
        sub={`Barcode ${barcode} isn't in the FastQue catalog yet. Add it once and it's ready for your stock; FastQue checks it before other salons can see it.`}
      >
        {suggestion && (
          <Banner tone="info">
            Suggested details from {suggestion.attribution} ({suggestion.license}). Check them against the pack before saving.
          </Banner>
        )}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          {photos.map((url) => (
            // eslint-disable-next-line @next/next/no-img-element -- just-uploaded packaging photos
            <img key={url} src={url} alt="Product packaging" className={styles.thumb} />
          ))}
          {photos.length < 4 && (
            <label className={styles.photoButton}>
              {photos.length ? "Add another photo" : "Photo of the front"}
              <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(e) => { void addPhoto(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
          {files.length > 0 && <Btn variant="quiet" onClick={() => void readPhotos()} disabled={reading}>{reading ? "Reading…" : "Read text from photos"}</Btn>}
        </div>
        {readNote && <p className={ui.hint} role="status">{readNote}</p>}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          <Field label="Product name" htmlFor="new-name">
            <input id="new-name" className={ui.input} maxLength={160} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Brand" htmlFor="new-brand">
            <input id="new-brand" className={ui.input} maxLength={120} value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
          </Field>
          <Field label="Category" htmlFor="new-category">
            <input id="new-category" className={ui.input} maxLength={80} value={form.category} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Shaving cream" />
          </Field>
        </div>
        <div className={ui.rowWrap}>
          <Field label="Pack size" htmlFor="new-size">
            <input id="new-size" className={ui.input} inputMode="decimal" value={form.packSize} onChange={(e) => set({ packSize: e.target.value })} />
          </Field>
          <Field label="Pack unit" htmlFor="new-unit">
            <select id="new-unit" className={ui.input} value={form.packUnit} onChange={(e) => set({ packUnit: e.target.value as InventoryUnit | "" })}>
              <option value="">—</option>
              {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </Field>
          <Field label="MRP (₹, as printed)" htmlFor="new-mrp">
            <input id="new-mrp" className={ui.input} inputMode="decimal" value={form.mrp} onChange={(e) => set({ mrp: e.target.value })} />
          </Field>
          <Field label="Used for" htmlFor="new-type">
            <select id="new-type" className={ui.input} value={form.productType} onChange={(e) => set({ productType: e.target.value as ProductType })}>
              <option value="BOTH">Services and selling</option>
              <option value="PROFESSIONAL">Services only</option>
              <option value="RETAIL">Selling only</option>
            </select>
          </Field>
        </div>
        {error && <div className={ui.mt12}><Banner tone="error">{error}</Banner></div>}
        <div className={`${ui.rowWrap} ${ui.mt12}`}>
          <Btn variant="primary" onClick={() => void submit()} disabled={busy}>{busy ? "Saving…" : "Save product"}</Btn>
        </div>
      </Card>
    </div>
  );
}
