# Smart Inventory — Phase 1 (Core Inventory)

Branch `feature/inventory-phase1` (from upstream `master` 86b7b79e). Phase 1 of the Smart Inventory
brief: Global Product Master, browser barcode scanning, product lookup, unknown-product onboarding,
CSV import, salon stock management and the stock ledger — plus the admin inventory KPIs.

## 1. What already existed (reused, not duplicated)

| Area | Existing | Phase 1 |
| --- | --- | --- |
| Salon inventory | `InventoryProduct`, `InventoryCategory`, `InventorySupplier` (salon-scoped) | Kept. Products gain an optional link to the Global Product Master, a shelf (professional / retail), selling price, storage place, minimum order quantity. |
| Stock ledger | `InventoryMovement`: append-only, idempotency key + request hash per salon, row lock, database trigger maintains stock and weighted average cost, stock can never go negative | Kept. New kinds RETURN, DAMAGE, EXPIRY, WASTAGE (stock leaving for a reason) and TRANSFER_OUT / TRANSFER_IN (shelf moves, always a pair). Batch/lot and expiry recorded on incoming stock. The trigger and its check constraint were extended, not replaced. |
| Owner UI | Shop → Inventory (10 pages) | New **Scan / Add stock** tab; Products list shows barcode, shelf and selling price; history shows the new entry kinds. |
| Access | Owner or platform admin (`assertOwnerOrAdminAccess`) | Same rule for every new salon route. |
| Photo storage | `ObjectStorageService` + byte-level image type check | Reused for packaging photos. |
| On-device OCR | Tesseract.js (service-menu import) | Reused for packaging photos — runs in the browser, nothing sent to a third party. |
| Admin shell | Admin Dashboard 2.1 (nav, date range, KPI cards) | New **Inventory** group: Inventory Overview, Product Catalog, Catalog Import. |

## 2. Design

**Barcodes** are text, never numbers. `normalizeBarcode` (packages/shared/product-catalog.ts) turns
EAN-13, EAN-8, UPC-A and GTIN-14 into a 14-digit GTIN after checking the check digit, so UPC-A
`036000291452` and EAN-13 `0036000291452` are the same product; UPC-E is expanded when the scanner
reports UPC-E; other symbologies (Code 128 …) are stored as uppercase text. One barcode belongs to
one catalog product (unique index); a product can have several barcodes.

**Verification.** A product a salon adds is `PENDING`: that salon sees its details and can stock it.
Another salon scanning the same barcode sees only "being reviewed" and can still stock it under its
own product name. An admin verifies (now visible to every salon) or rejects (with a reason). CSV
imports by admins are `VERIFIED`, with the source and licence recorded on every product.

**Outside lookups.** Open Beauty Facts is wired in but **off** (`OPEN_BEAUTY_FACTS_ENABLED`).
Its data is ODbL: attribution is required and a database built from it may have to be shared under
the same licence. Turn it on only after that review. When on, results are suggestions the salon
confirms, saved with source + licence; requests time out after 4 s and are cached for 24 h.

**Receiving stock** (`POST …/inventory/receive`) finds or creates the salon's product for that
catalog product + shelf and records the stock through the existing ledger: opening stock the first
time (no supplier), a purchase after that. An `Idempotency-Key` is required; a retry returns the
original entry.

**Shelf transfers** lock both products in id order and write TRANSFER_OUT / TRANSFER_IN with one
`transferGroupId`; the incoming side carries the source's average cost.

## 3. API

Salon routes (owner or platform admin, `dashboard/salons/:salonId/inventory/…`):

| Method & path | Purpose |
| --- | --- |
| `GET catalog/lookup?barcode=&hint=UPC_E` | FOUND / FOUND_PENDING / PENDING_ELSEWHERE / EXTERNAL / NOT_FOUND, plus this salon's stock per shelf |
| `POST catalog/products` | Submit an unknown product (PENDING) — 409 `CATALOG_BARCODE_EXISTS` if the barcode is taken |
| `POST catalog/images` (multipart `image`) | Packaging photo (JPEG/PNG/WebP, 5 MB) → `{ url }` |
| `POST receive` (`Idempotency-Key`) | Receive stock of a catalog product |
| `POST products/:productId/transfer` (`Idempotency-Key`) | Move stock to the other shelf |
| `POST products/:productId/movements` | Existing; now also RETURN / DAMAGE / EXPIRY / WASTAGE, batch + expiry on OPENING / PURCHASE |

Admin routes (`admin/…`; view = platform admin, co-founder, viewer; change = platform admin, co-founder):

| Method & path | Purpose |
| --- | --- |
| `GET inventory-overview?from=&to=&salonId=` | KPIs + shop-wise table + most-stocked products |
| `GET inventory-catalog?status=&q=&cursor=` | Catalog list with possible duplicates |
| `PATCH inventory-catalog/:id` `{ action: VERIFY \| REJECT, note?, fields? }` | Review (reject needs a note) |
| `POST inventory-catalog/import/preview` (multipart `file`) | Row-by-row validation, nothing saved |
| `POST inventory-catalog/import/commit` (multipart `file`, `sourceReference`, `sourceLicense`) | Save new rows as VERIFIED; re-running adds only what is missing |

CSV columns: `barcode,name,brand,manufacturer,category,subcategory,description,pack_size,pack_unit,mrp,hsn_code,gst_rate,product_type,image_url` (only `barcode` and `name` required; ≤ 5,000 rows / 2 MB).

## 4. Database

- `20261031100000_inventory_product_master` — additive: enums, `global_products`,
  `global_product_barcodes` (unique `code`), `global_product_images`, new nullable columns on
  `inventory_products` (+ unique `(salonId, globalProductId, usage)`) and `inventory_movements`.
- `20261031100100_inventory_movement_kind_rules` — widens the movement shape check and replaces the
  movement trigger function with the same logic plus the new kinds (separate migration because
  PostgreSQL can't use new enum values in the transaction that added them).

**Rollback:** both migrations only add. Redeploying the previous app version is safe with the
schema left in place (old code ignores the new tables/columns; it never writes the new kinds).
A full schema rollback would mean restoring the previous `fastque_inventory_apply_movement` body
and check constraint from `20261017140000_inventory_core`, then dropping the new tables/columns —
only after confirming no rows use the new kinds.

## 5. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPEN_BEAUTY_FACTS_ENABLED` | off | `true` turns on the outside barcode lookup (after licence review) |
| `OPEN_BEAUTY_FACTS_BASE_URL` | `https://world.openbeautyfacts.org` | API base |
| `PRODUCT_LOOKUP_USER_AGENT` | `FastQue-Inventory/1.0 (…)` | Descriptive User-Agent the service asks for |

No API keys or secrets. Photo uploads use the existing storage settings.

## 6. Testing

Automated: shared (barcode normalisation and check digits, UPC-E, CSV parsing/validation, schema
rules), backend (lookup visibility per salon, receive rules incl. retries, admin range), web
(packaging-text reader, USB-scanner detection, scanner states, Scan / Add stock flows, admin
overview + shop filter, catalog review, CSV import, admin menu permissions).

Checked over HTTP on a local database: wrong check digit refused; duplicate barcode refused; own
pending product visible; opening then purchase (average cost 10 @ ₹120 + 5 @ ₹150 = ₹130); retry
returns the original entry; shelf move carries the cost; not-enough-stock refused; damage write-off;
barcode search; another salon sees "being reviewed" and stocks under its own name; owner blocked
from another salon and from admin routes; admin KPIs and shop filter; reject needs a note; verify;
CSV preview/commit and idempotent re-import; leading-zero barcode still matches. Checked in the
browser: owner Scan / Add stock (lookup, new product, add stock to the retail shelf with batch and
expiry), camera-blocked message, admin Inventory Overview and Product Catalog.

**Camera scanning must be tried on a real device**: the in-app test browser blocks cameras. Use a
laptop webcam at `http://localhost:…` in Chrome/Edge, or a phone on an HTTPS preview — phones
reaching a laptop over plain `http://` on the LAN are refused camera access by the browser.

## 7. Known limitations

- Unit conversion (bottle → ml) and per-batch stock levels / expiry alerts are Phase 2–3; batch and
  expiry are recorded on each receipt now.
- Barber/staff access to inventory comes with the consumption screens (Phase 2).
- Duplicate review flags same name + brand; merging two catalog products is not built.
- Stock value adds each shop's figures in its own currency (all shops are INR today).
- Open Beauty Facts stays off until the ODbL licence review.
