# Smart Inventory — Phase 3 (Smart Prediction)

Branch `feature/inventory-phase1` (continues Phases 1–2). Phase 3 of the Smart Inventory brief:
consumption analytics, stock-out predictions, reorder recommendations, alerts and inventory reports.

## 1. What already existed (reused)

| Area | Existing | Phase 3 |
| --- | --- | --- |
| Ledger | Every stock change is an `InventoryMovement` (Phases 1–2: purchases, service use, write-offs, batch + expiry on receipts) | The only data source for forecasts and reports — nothing is estimated from outside it. |
| Recipes | `ServiceProductRule` (Phase 2) | Upcoming bookings × recipes give known future demand. |
| Notifications | In-app `Notification` + `NotificationsService` (with per-user preferences) | Two new owner types: `owner.inventory.reorder`, `owner.inventory.expiring` (category Reminders). |
| Scheduling | `DbDeadlineSchedulerService` (sleeps until the next real deadline; hourly safety net) | New job `inventory-alerts` (domain `inventory`), due once a day per shop. |
| Reports | Inventory → Reports (counts, value, low stock) | Adds period analytics with a CSV download. |

## 2. Forecasting (statistical, no paid AI)

`packages/shared/src/inventory-forecast.ts` → `forecastProduct()`, a pure function (method
`weighted-moving-average-v1`), so a smarter model can replace it later behind the same output.

- **Daily use**: the last 56 days of `CONSUMPTION` per product, by the shop's own day (time zone).
- **Rate**: `0.6 × last-14-day average + 0.4 × 56-day average` (only the 14-day average below 21 days
  of history). **Upcoming bookings** (next 14 days, confirmed) × each service's recipe set a floor:
  if they need more than recent use, the booking rate is used and the explanation says so.
- **Confidence**: *Not enough data* under 7 days of history or fewer than 3 days with use — then no
  prediction is shown ("record use for at least a week"), except the owner's own warning level still
  flags "order now". Low < 21 days or < 6 use-days; Medium < 42 or < 10; High otherwise.
- **Outputs**: days left = stock ÷ rate; stock-out date; reorder point = rate × (delivery days +
  cushion days); reorder date = when stock reaches that point; suggested order = rate × (delivery +
  cover + cushion) − stock, rounded up to whole units and to the minimum order quantity; trend
  (last 14 vs previous 14 days, ±15 %); status Out of stock / Order now / Order soon (within 7
  days) / OK / No prediction; and a plain-language explanation.
- **Assumptions** (per shop, Inventory → Predictions): delivery days (default 5), cushion days (3),
  days each order covers (14), alerts on/off. A supplier's own delivery days win over the default.

The brief's example — 500 ml, 25 ml/day, 5-day delivery, 3-day cushion — gives 20 days left and a
reorder in 12 days (at 200 ml, 8 days of cover); this is a unit test.

**Batches and expiry.** Stock is kept per product, so batches are *estimated*: assuming older stock
is used first, the stock on hand belongs to the newest receipts (`estimateBatches`). For each batch
expiring within 30 days (or already expired), `expiryRisks` estimates how much won't be used in time
at the forecast rate. Shown as estimates.

## 3. Alerts

`InventoryAlert` rows, at most one **open** alert per problem (partial unique index on
`(salonId, dedupeKey) WHERE resolvedAt IS NULL`):

| Kind | Raised when | Clears when |
| --- | --- | --- |
| `STOCK_OUT` | stock is 0 | stock is back |
| `REORDER` | status is Order now (reorder date reached, or at/below the warning level) | no longer Order now |
| `EXPIRING` | a batch expires within 7 days, or some of it is at risk of going unused | the batch is used up / passes into EXPIRED |
| `EXPIRED` | a batch's expiry date has passed and stock may remain | that stock is gone |

The daily job (and "Check for alerts now") creates new alerts, resolves those that went away, and
sends the shop owners **one** in-app notification per kind per run, listing the products, linking
to Inventory → Predictions — so a problem is announced once, not every day. Dismissing hides an alert
but does not resolve it, so it isn't raised again until the problem clears and recurs. In-app only:
no SMS / WhatsApp / email (no paid messages).

## 4. Reports

Inventory → Reports → **Consumption analytics** for the last 7 / 30 / 90 days or 12 months (counted
back from the shop's own today): bought, used, damaged/expired/wasted and stock now — totals, by
week, by category and by product (quantity and value at cost), with a **Download CSV** (formula-like
cells are neutralised for spreadsheets).

## 5. API (owner / delegated admin, `dashboard/salons/:salonId/inventory/…`)

| Method & path | Purpose |
| --- | --- |
| `GET predictions` | Forecast per product (most urgent first), summary, open alerts, settings, suppliers |
| `PUT forecast-settings` `{ leadTimeDays, safetyDays, coverDays, alertsEnabled }` | Assumptions |
| `PUT suppliers/:supplierId/lead-time` `{ leadTimeDays \| null }` | A supplier's delivery days |
| `POST alerts/run` | Check now (same as the daily job) → `{ created, resolved }` |
| `POST alerts/:alertId/dismiss` | Hide an alert |
| `GET analytics?days=30` (or `from=&to=`) | Period analytics |

`POST suppliers` also accepts `leadTimeDays`.

## 6. Database

`20261102100000_inventory_predictions` — additive only: enum `InventoryAlertKind`; tables
`inventory_settings` (one row per shop, created on first save or first daily run) and
`inventory_alerts`; column `inventory_suppliers.leadTimeDays`; the partial unique index and range
checks. **Rollback:** the previous version ignores these; dropping them removes no ledger data.

## 7. Configuration

None (no environment variables, keys or external services).

## 8. Testing

- `packages/shared/src/__tests__/inventory-forecast.test.ts`: the brief's example, reorder/order
  quantity with minimum order, weighting and trend, "not enough data", booking demand, out of stock,
  batch estimate and expiry risk, CSV safety.
- `apps/backend/test/inventory-forecast.e2e-spec.ts` (disposable `inventory_certification` DB only):
  predictions from 4 weeks of ledger history, supplier lead time turning a product into "order now"
  with the right quantity, alerts raised once and resolved, one owner notification with the deep
  link, an expiring batch at risk, dismiss, settings validation, the daily job, analytics totals,
  permissions.
- `apps/web/.../__tests__/forecast.test.jsx`: Predictions page, saving assumptions and a supplier
  delivery time, dismiss, the Overview reorder card, analytics.

## 9. Known limitations

- No day-of-week or seasonal model yet (needs months of data); the method name is versioned so a
  better model can be added.
- Batch quantities are estimated (oldest used first), not counted per batch.
- Alerts are in-app only; the notification uses the existing "Reminders" preference category.
- Suggested quantities are in the product's stock unit; supplier pack sizes and prices come with the
  B2B phase.
