# Smart Inventory — Phases 4–5 (B2B and B2C Commerce)

Branch `feature/inventory-phase1` (continues Phases 1–3). Phase 4: supplier onboarding, supplier
catalogs, purchase orders, supplier comparison, stock receiving, salon-to-salon marketplace.
Phase 5: customer shopping, salon listings, cart and orders, stock reservation, pickup, payment
through existing approved infrastructure. Built together because both share listings, orders and
reservations; one migration.

## Guard rails (from the brief)

- **No real payments activated.** Customers pay the salon at pickup (cash/UPI) or by the salon's
  own UPI QR that already exists in FastQue (`SalonPaymentPolicy.paymentQrImageUrl`); salons pay
  each other and suppliers on invoice. No money passes through FastQue; Razorpay is untouched.
- **Nothing is published without approval.** Suppliers and every listing are reviewed by a FastQue
  admin (PLATFORM_ADMIN or CO_FOUNDER) before anyone can see them; admins can suspend/take down.
- **Nobody is contacted.** Only in-app notifications are created; no SMS, WhatsApp or email.
- **Stock changes only through the ledger, exactly once** (idempotency keys per line), and a placed
  purchase order never changes stock — only a goods receipt does.

## 1. Reused

| Area | Reused | Added |
| --- | --- | --- |
| Ledger | `InventoryMovement` (+ trigger) | Receipts → `PURCHASE`; sales → `CONSUMPTION` (so dashboards/forecasts see depletion); returns and cancelled disputes → `ADJUSTMENT`. |
| Catalog | Verified `GlobalProduct` + barcodes | Supplier prices and listings only for verified products; barcode check on receipt. |
| Salon suppliers | `InventorySupplier` | `marketplaceSupplierId` link ("my supplier joined FastQue"); created automatically on first FastQue receipt. |
| Accounts | Ordinary FastQue sign-in, per-request access checks | Supplier portal = membership of an approved supplier; no new role or login surface. |
| Notifications / scheduler | In-app notifications; DB deadline scheduler | 4 new types; `marketplace-order-expiry` job. |

## 2. Phase 4 — B2B

**Suppliers.** Anyone signed in applies at `/supplier` (business, GSTIN, contact, cities served,
delivery days/charge, free-delivery threshold, minimum order) → PENDING → admin approves at Admin →
Inventory → Marketplace. Approved suppliers keep a price list per verified product (price per piece,
minimum order, optional stock — never assumed if not shared, delivery days), by hand or by CSV
(`barcode, supplier_sku, price, min_order, available, lead_time_days`; preview first, unknown
products reported, not created). They confirm, decline (with a reason) or mark dispatched the
purchase orders salons place with them.

**Comparing suppliers.** Inventory → Purchase orders → Compare: for a quantity, each supplier's
order quantity (minimum order applied), item total, delivery (free above the threshold), total,
days, stock flag and whether they list the shop's city — cheapest total first (`compareSuppliers`).

**Purchase orders.** Draft → (owner) Place → (supplier) Confirm → Dispatch; or to the shop's own
offline supplier (draft → place, then receive). FastQue orders always use the supplier's current
price and minimum order; supplier minimum order value is enforced. Cancel with a reason before
dispatch. Invoice photos can be attached.

**Receiving.** Per line: good quantity, damaged quantity, batch, expiry, the barcode scanned on the
box (must be the ordered product, else refused) and a discrepancy note. Good quantity → one
`PURCHASE` entry at the order price into the matching product (created from the catalog, counted in
pieces, if new); damaged is recorded only. Partial deliveries move the order to PARTIALLY_RECEIVED;
when everything is accounted for, RECEIVED. Each delivery has an Idempotency-Key — a retry adds
nothing.

**Salon-to-salon.** Inventory → Sell stock (to "Other salons") → admin review → other salons see it
under Purchase orders → Buy from other salons → order (on invoice) → seller accepts → dispatches
(seller stock deducted) → buyer confirms receipt (buyer stock added, at the price paid) or reports a
problem (→ DISPUTED; admin settles: buyer keeps goods, or sale cancelled and stock back to seller).

## 3. Phase 5 — B2C

**Shop** (`/shop`, public): products from approved customer listings, one card per product with the
lowest price and number of salons; search (name/brand), category, brand, city. Product page
compares salons (price, city, availability, best-before). Cart is kept in this browser; checkout
needs a customer sign-in and makes **one pickup order per salon**, each with a 6-digit pickup code.

**Listing eligibility** (`listingProblems`): active product, verified catalog product, not
professional-only for customers, sealed, at least one photo, invoice or provenance for salon sales,
whole pieces within stock not already listed (stock in ml/g is converted to whole packs), and at
least 30 days before expiry.

**Reservations.** Ordering locks the listings (`FOR UPDATE`, id order), checks
`listed − reserved − sold`, and reserves; a database check keeps `reserved + sold ≤ listed`.
Placing is idempotent per customer + key.

**Order lifecycle** (`ORDER_TRANSITIONS`): PLACED → ACCEPTED (seller, within 48 h, else EXPIRED) →
READY_FOR_PICKUP (customer told; 7 days to collect, else EXPIRED) → COMPLETED when the seller enters
the customer's code and confirms payment (seller stock deducted now). Customer can cancel while
PLACED; seller can cancel until handover. Returns within 7 days: customer asks → seller accepts
(stock put back, refund at the shop) or declines. Expired/cancelled orders release reservations.
"UPI received" lets the seller mark a UPI payment.

## 4. API

Salon (owner/admin) `dashboard/salons/:salonId/inventory/…`: `compare-suppliers`,
`marketplace-suppliers[/:id/offers]`, `suppliers/:id/link-marketplace-supplier`, `purchase-orders`
(+ `/:id`, `/:id/place|cancel|invoice|receive`), `listings` (+ `/:id/pause|resume|end`), `sales`
(+ `/:id/accept|ready|dispatch|mark-paid|cancel|complete|return-decision`), `salon-market`
(+ `/orders`), `marketplace-purchases` (+ `/:id/cancel|confirm-receipt|dispute`).
Supplier `supplier/…`: `me` (GET/PATCH), `apply`, `catalog-search`, `offers` (GET/PUT),
`offers/import/preview|commit`, `orders` (+ `/:id/confirm|reject|dispatch`).
Shop `shop/…`: `products` (public), `products/:id` (public), `orders` (customer: POST/GET,
`/:id/cancel|return`).
Admin `admin/…`: `marketplace-suppliers` (+ `/:id/review`), `marketplace-listings` (+ `/:id/review`),
`marketplace-orders` (+ `/:id/resolve`).

## 5. Database

`20261103100000_inventory_commerce` — additive: enums SupplierStatus, PurchaseOrderStatus,
ListingChannel, ListingStatus, MarketOrderStatus, MarketPaymentMethod; tables
marketplace_suppliers, supplier_members, supplier_offers, purchase_orders, purchase_order_items,
goods_receipts, goods_receipt_lines, market_listings, market_orders, market_order_items; column
inventory_suppliers.marketplaceSupplierId; checks (listing quantities, one supplier per PO, positive
quantities/prices). **Rollback:** the previous version ignores these; ledger entries stay valid.

## 6. Configuration

None. No keys, payment providers or outbound messaging.

## 7. Testing

- `apps/backend/test/commerce.e2e-spec.ts` (disposable `inventory_certification` DB only): the full
  chain above incl. permissions (owner on admin routes, other salon, customer on dashboard,
  anonymous ordering), MOQ, placing changing no stock, wrong barcode refused, partial + retried
  receipts, own-listing refused, overselling refused, stock moving once on dispatch/receipt/pickup,
  idempotent checkout, wrong pickup code / unpaid refused, return restocking, expiry releasing.
- `packages/shared` commerce rules are exercised through the e2e and web tests.
- `apps/web/.../__tests__/commerce.test.jsx`: product comparison + add to cart, checkout body and
  pickup code, PO from a supplier price list, listing submission, handover with the code.
- Checked in the browser on the local test shop: own-supplier PO draft → place → receive 48 good +
  2 damaged with a batch (stock 52 → 100, one PURCHASE entry), "Only 0 available to list" for a
  bottle with 11 ml left, the Shop and Sell stock pages.

## 8. Known limitations / next steps

- Online payment through FastQue (e.g. Razorpay) is deliberately not switched on; needs explicit
  approval, settlement and refund design.
- Delivery to customers is not built (pickup only); delivery fields are not modelled yet.
- Supplier returns after receipt use the existing "Returned to supplier" write-off; credit notes and
  supplier invoices as documents are not generated.
- GST invoices for marketplace sales, consumer-protection notices and resale compliance need a
  legal review before launch (brief Module 14).
- The cart lives in one browser; listings show no distance yet (city filter only).
- The supplier portal uses the customer site's sign-in; a dedicated supplier login page could come
  later.
