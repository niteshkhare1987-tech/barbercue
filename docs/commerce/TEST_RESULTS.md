# Test results and regression comparison

Windows 11, Node 24, PostgreSQL 18 in Docker, disposable local databases. Baseline = `8965d964`, before any change. "After" =
this branch including the merge of upstream master `0d4a5e81`, so it also contains tests added upstream.

| Suite | Baseline pass / fail / skip | After | Failing every time, not in the baseline |
| --- | --- | --- | --- |
| Shared unit | 698 / 0 / 0 | 720 / 0 / 0 | 0 |
| Web unit | 1527 / 5 / 0 | 1532 / 5 / 0 | 0 |
| Backend unit | 2286 / 1 / 0 | 2296 / 4 / 0 (full run) | 0: the 3 extra passed twice when run alone |
| All backend e2e | 401 / 25 / 16 | 437 / 27 / 17 (full run) | 0: the 2 extra are intermittent, see below |

Typecheck (backend, web), eslint on changed files, web production build with the admin flag on: pass. Migration chain with
both commerce migrations: no drift in commerce tables.

## Extra failures in the full run, and what was checked

- Backend unit: `two-factor-otp-sender` (a timeout test), `object-storage.service` and `salon-upi` (QR decode). This branch changes none
  of them, and local servers and a headless browser were running at the time. Run alone: 44 of 44, twice.
- `assistant-rollout` #372: 401 instead of 200. Failed in the full run and in two runs right after it, then passed in five runs in a
  row. It also failed once before the first commerce commit's regression. It is intermittent; its cause was not found, and it was not
  compared with a clean master checkout.

## Failing before this work (not fixed here)

- Web: 5 in `ArrivalAlertOverlay.test.jsx`.
- Backend unit: 1 QR photo decode in `salon-upi.service.spec.ts`.
- E2E: 25 in `owner-ops`, `queue`, `booking`, `inventory`, `salon-setup-activation`, `rbac`, `customer-assistant-search`, `discovery`.

## Commerce e2e (34 tests, all pass)

`commerce.e2e-spec.ts` (17): flags, isolation, checkout, FEFO, concurrency, state machine, COD, returns, coupons, procurement, mixed
checkout, reports, data quality, addresses.

`commerce-extras.e2e-spec.ts` (17): every new route hidden while off; owners, customers and ungranted admins refused; reviews; support and
internal notes; offers and refunds of offers; details, banners, return rules; photos; stock import; settlement import; bulk steps
and Excel; warehouse limits; blind counts; requests, quotations and supplier returns; pickups; bag, recommendations, counters;
forecasts and cost protection; alerts and invoices. Concurrent double submits are tested for reviews, imports, settlements,
counts, purchase orders and pickups.

## Browser check (headless Edge, production build)

Storefront, product, bag, checkout, order help, saved addresses, all 17 admin tabs, stock count, scan panel, reply suggestion, bulk
steps, offers, details, and the four print documents. 1280/1440 px and 375 px: no sideways scroll. No script errors. One notification
request got a 500 from a reset connection between the web server and the backend; it did not repeat. No unlabelled field, unnamed
button or image without alt text in the main area of these pages. Screenshots: `screenshots/` (demo data).

## Load

Catalogue service, 3,005 listings, 10 callers at once on a laptop: list 475 ms (1,563 ms before the fix in this branch), search 409,
home 714 (cached publicly for 60 s), product 72, PIN check 5 (medians). Measured in-process because the API is rate limited per
client. Checkout was tested for correctness under concurrency, not for throughput.

Not done: load test on production hardware, external penetration test, screen-reader testing, camera scan on a real phone, mobile apps.
