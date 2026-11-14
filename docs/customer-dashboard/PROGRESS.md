# FastQue Customer Dashboard — progress log

Resumable work log for the 20-phase "Premium Customer Dashboard" brief (started 2026-11-13).
Nothing here is pushed, merged or deployed. Real-money gift cards stay OFF.

## Phase 0 — audit findings (what already exists)

| Area | Existing implementation | Decision |
|---|---|---|
| Customer area | `apps/web/app/(customer)/account/*` (bookings, favorites, invoices, credits, profile, premium) behind `RequireRole([CUSTOMER])` | Upgrade in place into the dashboard; keep every existing URL working |
| Global header | `SiteHeader` in root layout (logo, nav, bell, account menu) | Reuse; dashboard adds a sidebar + slim top bar only |
| Brand | `globals.css` tokens: `--bc-brand-navy #1a1533`, pink→coral→orange `--bc-brand-gradient`, cream `--bc-surface`, Fraunces/Work Sans | Keep original FastQue colours (user instruction) |
| Salon search | `/search` → `SearchClient.tsx`, URL-driven via `lib/discovery-params.ts`, API `GET salons` (`SalonsService.search`) | Reuse the same component + API for Discover (basePath prop). No second search system |
| Filters | salon type, popular service, price, distance (lat/lng/radiusKm), rating, open now, offers, max wait, favourites-only, sort | Preserved unchanged |
| Map | None. Directions use plain Google Maps deep links (no key) | Add Leaflet (lazy) + own grid clustering; tiles configurable via `NEXT_PUBLIC_MAP_TILE_URL` |
| Favourites | `CustomerFavorite` table (unique userId+salonId), `favorites` API, shared optimistic store `lib/favorites.ts` | Reuse as-is |
| Recently viewed | None | New: `CustomerRecentSalonView` table + `recently-viewed` API; guests use localStorage |
| Bookings | `bookings/mine` (cursor), cancel/reschedule/check-in dialogs, `BookingActionsBar`, `ReviewPanel` | Add optional server-side filters (date range, status, salon, sort) |
| Live queue | `queue-entries/mine/active`, `QueueStatusPanel` (realtime) | Reuse on dashboard home and Live Queue tab |
| Reviews | Create/update per completed booking (one per booking) | Add `GET reviews/mine` |
| Invoices | `invoices/mine` (ownership in WHERE), PDF download | Add optional filters + salon name |
| Loyalty | FastQue Credits: append-only `CustomerCreditTransaction` ledger, idempotent grants | Present as Rewards ledger; no invented earn rate |
| Gift cards | None, no gift-card payment/settlement stack | UI only, behind `NEXT_PUBLIC_FEATURE_GIFT_CARDS` (default off) |
| Referral | None | Not built (no rules/abuse controls); listed as future |
| Notifications | `notifications/mine`, preferences, `NotificationBell` | Reuse for Recent Activity |
| Share | Owner-only `lib/shop-share.ts` helpers | Reuse helpers for customer Share sheet |
| Customer name | Not stored anywhere ("FastQue stores no customer name") | Greeting falls back to "Good morning!" |

## Stage status

- [x] Stage 1 — shell, routes, overview
- [x] Stage 2 — Discover reuse, list/map, favourites sync, recently viewed, share
- [x] Stage 3 — appointments filters, reviews, invoices, settings
- [x] Stage 4 — rewards ledger (FastQue Credits) + gift-card UI behind `NEXT_PUBLIC_FEATURE_GIFT_CARDS` (off; no issuance backend)
- [~] Stage 5 — rebook (existing "Book again"), notifications (Recent Activity from existing notifications). Recommendations & referral NOT built.
- [x] Verification — typecheck web/backend/shared clean; backend 2167/2167, shared 533/533, web 1428/1434 (ArrivalAlertOverlay voice tests fail; untouched files); `next build` OK

## Log
- 2026-11-13 — Backend (additive): `salons` search map bounds (minLat/maxLat/minLng/maxLng); `recently-viewed` API + `customer_recent_salon_views` migration (deleted with account); `GET reviews/mine`; optional filters on `bookings/mine` (from/to/status/salonId/sort) and `invoices/mine` (from/to/salonId/q) + `salonName` on invoice summary. Specs added; related suites pass.
- 2026-11-13 — Web: dashboard shell (sidebar/top bar/mobile bottom nav) replaces the old account tab bar; `/account` home; `/account/discover` reuses `SearchClient` (basePath + List/Map); Leaflet map with grid clustering, list↔map sync, "Search this area"; Share sheet on all salon cards + detail page; recently-viewed tracking on salon detail; customer landing changed from `/account/bookings` to `/account`; My Appointments rebuilt with tabs/filters/sort/invoice links.
- 2026-11-13 — Rewards, Reviews, Invoices, Favourites (nearest/price sort), Settings (location, sign-in method, privacy). Map View uses compact cards. Browser-verified (signed out): map clustering + pin/list sync + "Search this area", share sheet, salon detail heart/share + guest recent history, mobile layout, /account redirect to login. Local dev DB: applied migration 20261113100000 only.

## Not done / blocked
- Signed-in dashboard pages not browser-verified: local customer login needs a real OTP provider or Google.
- Gift cards: UI preview only; needs payment flow, issuance/redemption ledger, settlement, GST/RBI PPI review.
- Referral programme, smart recommendations, past live-queue history list, review photos, server-side preferred city, self-serve data export.
- Map tiles default to public OpenStreetMap; set `NEXT_PUBLIC_MAP_TILE_URL` (+ attribution) to a commercial provider before production traffic.
- Discover map uses limit=50 per search (API max); larger cities need "Search this area" or a paging follow-up.
