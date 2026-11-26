# Test results

## Before and after

| Suite | Before (c55c7ee6) | After |
|---|---|---|
| Backend unit | 2300 passed | 2300 passed |
| Backend e2e | 409 passed, 21 failed, 17 skipped | 449 passed (40 new), the same 21 failed, 17 skipped |
| Shared | 704 passed | 711 passed (7 new) |
| Web | 1532 passed, 5 failed | 1537 passed (5 new), the same 5 failed |
| Migration chain on an empty database | passed | passed |
| Production builds | – | backend and web passed |

The 21 failing backend e2e tests are identical before and after (compared by test name): `queue` and `booking` do not compile on master (token signature changed); `discovery`, `salon-setup-activation`, `rbac` and `customer-assistant-search` need seeded or different data. The 5 web failures are the known ArrivalAlertOverlay tests.

One existing test was changed: `admin-shell.test.jsx` counts admin sections; it now expects 16 because a FastQue Home section was explicitly requested.

## Performance (local, 25 sequential requests, same database)

| Endpoint | Before p50 / p95 | After p50 / p95 |
|---|---|---|
| Salon availability | 24.9 / 27.0 ms | 26.7 / 29.0 ms |
| Queue status | 10.4 / 11.0 ms | 10.2 / 10.8 ms |

Not load-tested.

## The 70 mandatory scenarios

| # | Scenario | Result | Where |
|---|---|---|---|
| 1 | Customer location selection | Passed | home-services.e2e |
| 2 | Manual address entry | Passed | home-services.e2e |
| 3 | Service search | Passed | home-services.e2e |
| 4 | Salon home-service discovery | Passed | home-services.e2e |
| 5 | Independent professional discovery | Passed | home-services.e2e |
| 6 | Service price comparison | Passed | home-services.e2e |
| 7 | Specific professional booking | Passed | home-services.e2e |
| 8 | Specific salon booking | Passed | home-services.e2e |
| 9 | Fastest available professional booking | Passed | home-services.e2e |
| 10 | Instant booking | Passed | home-services.e2e |
| 11 | Scheduled booking | Passed | home-services.e2e |
| 12 | Multiple-service booking | Passed | home-services.e2e |
| 13 | Family booking | Passed | home-services.e2e |
| 14 | Guest booking | Partly | home-services.e2e: gating, token access, cancel. SMS code delivery needs the OTP provider |
| 15 | Offline payment selection | Passed | home-services.e2e |
| 16 | Booking cancellation | Passed | home-services.e2e |
| 17 | Rescheduling | Passed | home-services.e2e |
| 18 | Rebooking | Passed | home-services.e2e |
| 19 | Reviews | Passed | home-services.e2e |
| 20 | Salon home-service activation | Passed | home-services.e2e |
| 21 | Home-service listing creation | Passed | home-services.e2e |
| 22 | Professional assignment | Passed | home-services.e2e |
| 23 | Independent professional registration | Passed | home-services.e2e |
| 24 | Availability management | Passed | home-services.e2e |
| 25 | Service area management | Passed | home-services.e2e |
| 26 | Home-service pricing | Passed | home-services.e2e |
| 27 | Professional acceptance | Passed | home-services.e2e |
| 28 | Professional rejection | Passed | home-services.e2e |
| 29 | Professional cancellation | Passed | home-services.e2e |
| 30 | Travel status updates | Passed | home-services.e2e |
| 31 | Service check-in | Passed | home-services.e2e |
| 32 | Service completion | Passed | home-services.e2e |
| 33 | Payment confirmation | Passed | home-services.e2e |
| 34 | Existing salon appointment conflict | Passed | home-services.e2e |
| 35 | Existing live queue conflict | Passed | home-services.e2e |
| 36 | FastQue Talent shift conflict | Partly | home-services.e2e: FastQue Work on-site gig. Talent shifts are not on master |
| 37 | Simultaneous booking attempts | Passed | home-services.e2e |
| 38 | Double-booking prevention | Passed | home-services.e2e |
| 39 | Salon minimum staff protection | Passed | home-services.e2e |
| 40 | Travel-time validation | Passed | home-services.e2e |
| 41 | Appointment preparation buffer | Passed | home-services.e2e |
| 42 | Appointment overrun | Passed | home-services.e2e |
| 43 | ETA recalculation | Partly | home-services.e2e: delay and at-risk; recalculation after shared location runs but its value is not asserted |
| 44 | Routing provider failure | Passed | home-services.e2e |
| 45 | Stale location data | Passed | home-services.e2e |
| 46 | GPS permission denial | Passed (API) | home-services.e2e: declined consent keeps status-only. Not tried on a physical phone |
| 47 | Scheduled slot feasibility | Passed | home-services.e2e |
| 48 | Booking hold expiration | Passed | home-services.e2e |
| 49 | Replacement professional assignment | Passed | home-services.e2e |
| 50 | Concurrent invitation acceptance | Passed | home-services.e2e |
| 51 | Unauthorized customer address access | Passed | home-services.e2e |
| 52 | Unauthorized live tracking access | Passed | home-services.e2e |
| 53 | Location tracking termination | Passed | home-services.e2e |
| 54 | Cross-provider data isolation | Passed | home-services.e2e |
| 55 | OTP expiration and replay prevention | Passed | home-services.e2e |
| 56 | Fake payment confirmation prevention | Passed | home-services.e2e |
| 57 | Unauthorized price changes | Passed | home-services.e2e |
| 58 | Customer support escalation | Passed | home-services.e2e |
| 59 | Safety incident reporting | Passed | home-services.e2e |
| 60 | Feature flag behavior | Passed | home-services.e2e: flags test; web entry-points test |
| 61 | Database migration safety | Passed | Full migration chain on an empty database with legacy fingerprints; no drift for home tables |
| 62 | Notification deduplication | Passed | home-services.e2e: one notification per event after repeated sweeps |
| 63 | Mobile responsiveness | Passed | Built-in browser at 375 px: landing, home landing, search, booking, tracking, account, professional dashboard; no sideways scroll |
| 64 | Existing queue management regression | Passed, with a gap | Queue unit specs and live-queue e2e suites. `queue.e2e-spec.ts` does not compile on master either |
| 65 | Existing salon booking regression | Passed, with a gap | Booking/availability/reservation unit specs, owner-ops e2e, race test 37b. `booking.e2e-spec.ts` does not compile on master either |
| 66 | Existing marketplace regression | Passed | shop.e2e, offers.e2e |
| 67 | Existing inventory regression | Passed | inventory suites; home-services.e2e: one ledger movement |
| 68 | Existing FastQue Talent regression | Blocked | FastQue Talent is not on master. FastQue Work e2e passed |
| 69 | Existing CRM regression | Passed | crm-2.e2e, employee-field-ops.e2e, admin-crm-analytics.e2e |
| 70 | Performance comparison | Passed | See performance below |

## Not tested

Real SMS/push, physical phones, Neon, concurrent load, light-theme owner/admin screens in detail, screen readers.

## After merging FastQue Commerce (master 4b14ae59)

| Suite | Result |
|---|---|
| Migration chain from empty, drift checks | pass (Commerce then Home); a database that already had Home also took the Commerce migrations |
| Backend unit | 2300 passed |
| Backend e2e | 483 passed, the same 21 known failures as master (second full run; the first run had one extra notifications-count failure that passed 3 of 3 alone and in the rerun) |
| Shared | 729 passed |
| Web | 1537 passed, the same 5 known ArrivalAlertOverlay failures |
| Type checks, backend build, web build (Home and Commerce flags on) | pass |
