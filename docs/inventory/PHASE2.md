# Smart Inventory — Phase 2 (Service Consumption)

Branch `feature/inventory-phase1` (continues Phase 1). Phase 2 of the Smart Inventory brief:
service-product mapping, photo-based product selection, configurable consumption recipes,
automatic inventory deduction and the inventory dashboard.

## 1. What already existed (reused)

| Area | Existing | Phase 2 |
| --- | --- | --- |
| Services | `Service` per salon; multi-service bookings in `BookingService` | Recipes attach to existing service ids; a visit's services are its booking's services (in order) or the walk-in's service. |
| Service completion | `ServiceSession` → `QueueService.completeSession` — the only place a service (and booking) is completed; barbers may only complete their own | A dependency-free `ServiceCompletedHook` (same pattern as `QueueAutoAssignTrigger`) is notified after completion; inventory registers on it. Completion itself is unchanged and can never fail because of inventory. |
| Ledger | `InventoryMovement` (append-only, idempotency key, row lock, DB trigger for stock and average cost) | Every product used is a `CONSUMPTION` entry; a correction is an `ADJUSTMENT` entry. No direct stock writes. |
| Categories | Salon `InventoryCategory` | Recipe lines point at the salon's own categories ("Shaving cream"). |
| Barber screens | Owner Live Queue and barber home both have **Complete service** | Both now open "Products used" first — only when the service has a recipe. |

## 2. Design

**Recipes (service → product categories).** `ServiceProductRule`: service, inventory category,
amount + unit, optional usual product, and an explicit "take it off stock automatically" tick (needs
the usual product). Suggestions for common services (Shaving → shaving cream, blades, aftershave;
Hair colour → hair colour, developer, colour treatment; …) are a keyword table in
`packages/shared/src/service-usage.ts` — rule-based, no AI, and only suggestions: the salon adds the
lines and sets its own amounts. Adding a suggestion creates the category if the salon doesn't have it.

**Photo-based selection.** On Complete, the barber sees large photo cards (catalog photo, or a box
icon) of the shop's own products in each recipe line's category on the "used on services" shelf,
with stock left, "used recently", and an amount stepper with sensible units. Nothing is pre-chosen
except the owner's usual product. "Something else was used" adds any professional product.
Multi-service visits get a section per service. "Complete without recording" is always there.
Services without a recipe complete exactly as before (no extra step).

**Unit conversion.** Products counted in pieces/packs/boxes can say what one contains
(`contentSize` + `contentUnit`, e.g. 1 bottle = 195 ml). 10 ml of that bottle is 0.051 pieces
(ledger precision is 3 decimals, never rounded down to zero). ml↔L and g↔kg convert directly. Other
combinations are refused with a reason. Received-by-scan products get this from the catalog pack
size; the migration back-fills it for products already linked to the catalog.

**Recording — exactly once.** `ServiceUsage` (one per service per visit) + `ServiceUsageItem` (one
per product, owning its ledger entry). A partial unique index allows only one RECORDED usage per
(visit, service): a double tap, a retry or a repeated completion event returns the existing record
and deducts nothing more; different products for an already-recorded service are refused (correct
it instead). The whole visit is one transaction: products are locked in id order, stock is checked
for all lines together, and if anything is short **nothing** is deducted.

**Automatic deduction.** After completion, for each service with nothing recorded whose every recipe
line has a usual product *and* the automatic tick, those products are deducted (source `AUTO`).
Otherwise nothing is assumed — the brief's rule that a default is never treated as used without an
explicit salon-approved rule. Failures (e.g. not enough stock) are logged and the visit shows as
"products not recorded".

**Corrections.** Owner/admin only, with a reason: each line gets an `ADJUSTMENT` putting the stock
back, the usage becomes REVERSED (who, when, why), and the right products can then be recorded.

**Who can do what.** Recipes, the Product usage page, corrections and the dashboard: owner or
delegated platform admin. Recording products for a visit: owner/admin any time once the service has
started; a barber only for a customer they are serving or served, up to 12 hours after completion.
Barbers never see costs.

**Dashboard (Inventory → Overview).** Products in use, low, out of stock, expiring within 30 days,
stock value at cost; products used at cost today / 7 days / 30 days with a 30-day daily chart;
bought, retail-shelf out and damaged/expired/wasted (30 days); use by service; most used products;
expiring batches; a nudge for visits in the last 7 days with a recipe but no products recorded.
All figures are computed by the server from the ledger, in the shop's time zone; the page refreshes
every minute.

## 3. API

Owner/admin (`dashboard/salons/:salonId/inventory/…`):

| Method & path | Purpose |
| --- | --- |
| `GET service-recipes` | Every service with its recipe lines and suggestions |
| `PUT service-recipes/:serviceId` `{ lines: [{ inventoryCategoryId, quantity, unit, defaultProductId?, autoDeduct }] }` | Replace a service's recipe |
| `GET service-visits?from=&to=&filter=all\|missing\|recorded` | Completed visits (default last 7 days) with products recorded per service |
| `POST service-usage/:usageId/reverse` `{ reason }` | Correction: put the stock back |
| `GET dashboard?to=` | The inventory dashboard |

Barber/owner/admin (`dashboard/queue-entries/:queueEntryId/product-usage`):

| Method | Purpose |
| --- | --- |
| `GET` | The photo-picker options for this visit (services, recipe lines with product ids, products, what's already recorded) |
| `POST` `{ services: [{ serviceId, items: [{ productId, quantity, unit, ruleId? }] }] }` | Record the products used; safe to repeat |

Products: `POST/PATCH …/inventory/products` accept `contentSize` + `contentUnit` (both or neither).

## 4. Database

`20261101100000_inventory_service_consumption` — additive only:
enums `ServiceUsageStatus`, `ServiceUsageSource`; tables `service_product_rules`, `service_usages`,
`service_usage_items`; columns `inventory_products.contentSize/contentUnit`; a partial unique index
(one RECORDED usage per visit + service); checks (positive amounts, automatic needs a usual product,
reversal fields all-or-nothing, contents both-or-neither); and the back-fill described above.

**Rollback:** redeploying the previous version is safe with the schema left in place (old code
ignores the new tables/columns; its Complete button just completes). A full schema rollback drops
the three tables, the two enums and the two columns — the ledger entries they created stay valid
CONSUMPTION/ADJUSTMENT entries.

## 5. Configuration

None. No new environment variables, keys or external services.

## 6. Testing

- `apps/backend/test/service-usage.e2e-spec.ts` (real AppModule + disposable PostgreSQL named
  `inventory_certification` only): recipe permissions; barber can only see their own customer's
  visit; ml → pieces conversion (10 ml of 200 ml = 0.05); repeated save deducts nothing; a different
  save is refused; unconvertible units refused; not enough stock → nothing deducted at all; owner
  correction restores stock and allows re-recording; automatic deduction on completion and the same
  completion event delivered twice deducting once; visits list and dashboard owner-only.
- `packages/shared/src/__tests__/service-usage.test.ts`: conversions, suggestions, schema rules.
- `apps/web/.../__tests__/service-usage.test.jsx`: photo cards, only the usual product preselected,
  save-then-complete body, no-recipe services complete straight away, complete without recording,
  already-recorded summary. `inventory-views.test.jsx`: dashboard on Overview, 13 inventory tabs.

## 7. Known limitations

- Stock is per product, not per batch: expiry shows batches received with an expiry date while the
  product still has stock (FIFO batch tracking is Phase 3).
- No shade/variant hierarchy yet for large colour ranges (Brand → Product → Shade): products are
  cards in their category, recent first.
- Retail sales are not a separate entry kind; the dashboard reports stock taken off the retail shelf.
- The barber mobile app (Expo) is unchanged; the products step is on the website's barber and owner
  screens.
- A walk-in with no service chosen has nothing to record against.
