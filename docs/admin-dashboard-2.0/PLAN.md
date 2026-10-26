# FastQue Admin Dashboard 2.0 — assessment and plan

Status: Phase 1 in progress. Started 2026-10-26 on `feature/nitesh-development`.
This document is the source of truth for what the blueprint asks for, what the current system can
already answer, and what needs new tracking before it can be reported honestly.

## 1. Current architecture (what exists today)

| Area | What is there | Where |
| --- | --- | --- |
| Monorepo | npm workspaces: `apps/backend` (NestJS + Prisma + PostgreSQL), `apps/web` (Next.js, client admin pages), `apps/mobile` (Expo), `packages/shared` (types, zod schemas, path constants) | root `package.json` |
| Auth / RBAC | JWT + refresh cookie; `@Roles()` + global `RolesGuard` on every route; admin login is password/Google **plus mandatory TOTP** | `apps/backend/src/auth` |
| Internal roles | `PLATFORM_ADMIN`, `CO_FOUNDER`, `HR_ADMIN`, `SALES_ADMIN`, `PLATFORM_VIEWER` (read-only), `FIELD_EXECUTIVE` | `Role` enum |
| Admin UI | `/dashboard/admin` (platform overview, shops, staff, customers, recent activity, **Shop activity** date filter), `/crm` (field CRM + analytics), `/employees`, `/verification`, `/access` | `apps/web/app/(dashboard)/dashboard/admin` |
| Admin API | `GET admin/overview`, `GET admin/shop-activity`, CRM analytics/pages, verification, employee and access management | `apps/backend/src/admin` |
| Owner analytics | per-shop overview, revenue, peak hours, capacity — single-shop scoped | `owner-ops`, `dashboard-analytics` |
| Time zones | per-salon `timezone`, IST default; helpers in `common/timezone` | |

### Data the reporting can rely on

| Need | Source | Quality |
| --- | --- | --- |
| Scheduled appointments | `Booking` (`slotStart`, `createdAt`, `status`, `source` = APP / WEB / WALK_IN / IN_SHOP, `cancelledByActor`, `cancellationReason`) | Good. No `completedAt`; completion time comes from the linked queue entry. |
| Live / walk-in visits | `QueueEntry` with `source = WALK_IN` (`joinedAt`, `serviceStartedAt`, `serviceCompletedAt`, `status`) | Good. Walk-ins are **not** `Booking` rows. |
| Scheduled vs live | `Booking` vs `QueueEntry.source = WALK_IN`; an appointment that checks in becomes `QueueEntry.source = APPOINTMENT` and stays a booking | Good — satisfies "a checked-in scheduled booking stays scheduled". |
| Service items + price snapshot | `BookingService` (name, duration, price snapshot); legacy single-service bookings fall back to `Booking.service` | Good for appointments. Walk-ins only have the **current** menu price → reported as an estimate. |
| Actual service time | `ServiceSession` (`startedAt`, `endedAt`, `COMPLETED`) and queue `serviceStartedAt/CompletedAt` | Good. |
| Chairs / hours | `Chair`, `OperatingHours`, `StaffWorkingHours`, `ManualChairOccupancy` | Enough for utilisation (Phase 3). |
| Salon lifecycle | `Salon.createdAt`, `status`, `VerificationRequest`, CRM lead → salon attribution | Partial: no lifecycle event history, no activation timestamp. |
| Sales attribution | `EmployeeCrmLead` (employee → onboarded salon), visits, follow-ups | Partial: one owner per lead, no effective-dated territory history. |
| Money | Customer `Payment`/`Refund` (prepayments), shop `Invoice`/`InvoicePayment` (shop's own billing), `CustomerSubscription` (customer Premium) | **FastQue platform revenue (commissions, shop subscriptions, ads) is not recorded.** |
| Merchant app activity | Only refresh-token/session rows | Not an activity log — cannot say "owner used the app on N days". |
| Geography | `City` → `Region` (state) → `Country`; no sales regions or areas | Territories must be added. |

## 2. Requirement mapping

Legend: ✅ can build on existing data · 🟡 partial / estimate · ⛔ needs new tracking first.

| Blueprint section | Status | Notes |
| --- | --- | --- |
| 3 Global filters — date presets, IST, previous-period comparison | ✅ | Built in Phase 1 slice 1. Geography/salesperson/source filters next. |
| 3 CSV/XLSX export | ✅ | Phase 1; CSV first (formula-injection safe). |
| 4 Executive KPIs: salons registered / active / serving, bookings created / completed / cancelled / no-show, live vs scheduled, service value, service hours, avg value, rates | ✅ / 🟡 | Walk-in value is an estimate (current menu price). |
| 4 FastQue platform revenue | ⛔ | Shown as "Not tracked yet", never as zero. Needs a platform-fee ledger. |
| 4 Daily / weekly / monthly active salons (commercial) | ✅ | Defined on completed visits. |
| 4/5 Merchant engagement (app usage) | ⛔ | Needs a merchant activity-event table. Kept separate from booking activity. |
| 5 Adoption categories | 🟡 | Booking-based categories now; the "15 active app days" part of *Highly active* waits for activity events. |
| 5 Lifecycle milestones as history | ⛔ | Needs `salon_lifecycle_events` (additive migration) + backfill from existing timestamps. |
| 6 Shop-wise performance | ✅ | Table in slice 1; detail page in slice 2. |
| 7 Booking analytics (status, actor, hour/day, lead time, source) | ✅ | `cancelledByActor`, `source`, `createdAt` vs `slotStart` exist. Status-transition history ⛔ (no table). |
| 8 Service-wise reporting | 🟡 | Per-salon `SalonServiceCategory` exists; needs a canonical platform category mapping. |
| 9 Hours & utilisation | ✅ | Phase 3: sessions + chairs + operating hours. |
| 10 Revenue & monetisation | 🟡 / ⛔ | Salon service value ✅; FastQue revenue ⛔. |
| 11 Cancellations & no-shows | ✅ | |
| 12 Live queue monitoring | ✅ | Predicted vs actual wait needs prediction snapshots ⛔ (`estimatedWaitMinutes` is only the latest value). |
| 13 Regional sales | 🟡 | Needs territories, effective-dated assignments, targets. CRM gives visits / leads now. |
| 14 Customers & retention | ✅ | Account customers only; guests are not identifiable across visits. |
| 15 AI / marketing | ⛔ | Needs discovery/agent event tracking. `BookingAttributionCampaign` covers shop campaigns. |
| 16 Alerts & action centre | 🟡 | Rules can run on existing data; alert/task tables are new. |
| 2 RBAC — Director, National Ops, Regional/City manager, Finance, Support | ⛔ | New roles + territory scoping. Until then the command centre is limited to `PLATFORM_ADMIN`, `CO_FOUNDER`, `PLATFORM_VIEWER`. |

## 3. Phases

**Phase 1 — Core MVP** (this branch)
1. ✅ Shop activity: shop-wise bookings and live queue with IST date filter (`admin/shop-activity`).
2. 🔄 Executive Command Center (`/dashboard/admin/command-center`, `admin/analytics/overview`): KPI cards with previous-period change, completed-visits trend, shop adoption distribution, salon performance table.
3. Booking analytics page: status / cancellation actor / source / hour-of-day / day-of-week / lead time.
4. Service performance: canonical category mapping + per-service KPIs.
5. CSV export for every Phase 1 table, audited.
6. Geography filter (state → city) on all Phase 1 endpoints.

**Phase 2 — Sales and adoption** — territories + effective-dated assignments, lifecycle events, merchant activity events, onboarding funnel, recovery table with follow-up tasks, new roles.

**Phase 3 — Operations and finance** — utilisation + heatmap, queue prediction snapshots, platform-fee ledger, reconciliation, alert rules.

**Phase 4 — AI and growth** — discovery/agent event tracking, attribution, retention cohorts, forecasting.

## 4. KPI definitions (implemented)

All dates are IST calendar days (`Asia/Kolkata`). "Previous period" is the same number of days immediately before the selected range.

| KPI | Definition | Basis |
| --- | --- | --- |
| Registered salons | Salons created on or before the end of the period | Snapshot at period end |
| New salons | Salons created inside the period | Event (`Salon.createdAt`) |
| Open salons | Salons whose status is `ACTIVE` right now | Current state (no comparison) |
| Serving salons | Salons with ≥ 1 completed appointment or served walk-in in the period | Event |
| Appointments booked | Bookings **created** in the period, any status | Event (`createdAt`) |
| Completed appointments | Bookings with appointment time in the period and status `COMPLETED` | Event (`slotStart`) |
| Walk-ins served | Walk-in queue entries that joined in the period and were `COMPLETED` | Event (`joinedAt`) |
| Completed visits | Completed appointments + walk-ins served | Derived |
| Cancelled / No-show | Bookings with appointment time in the period and that status | Event (`slotStart`) |
| Cancellation rate | Cancelled ÷ (completed + cancelled + no-show) appointments | Pending/confirmed excluded from the denominator |
| No-show rate | No-show ÷ (completed + no-show) appointments | Only resolved attendance outcomes |
| Completed service value | Appointments: price snapshot of the booked services minus the online-booking discount. Walk-ins: current menu price of the chosen service (**estimate**, shown separately). Salon money — **not** FastQue revenue. | Event |
| Average visit value | Completed service value ÷ completed visits with a known value | Derived |
| Completed service hours | Sum of `endedAt − startedAt` of completed service sessions that ended in the period | Event (actual times) |
| FastQue platform revenue | Not tracked yet — returned as `null` and shown as "Not tracked" | — |

### Adoption categories (as of the end of the period, 30-day window)

Thresholds live in one place (`ADMIN_ADOPTION_THRESHOLDS` in `packages/shared`) and are proposals, not industry standards. Admin-editable thresholds are Phase 2.

| Category | Rule (first match wins) |
| --- | --- |
| Recently onboarded | Registered within the last 7 days |
| Never activated | No completed visit ever |
| At risk | Previous 30 days had ≥ 10 completed visits and the last 30 days fell by ≥ 50 % |
| Highly active | ≥ 20 completed visits in the last 30 days *(merchant-app-days criterion waits for activity tracking)* |
| Moderately active | 5–19 completed visits |
| Low usage | 1–4 completed visits |
| Dormant | Completed visits before, none in the last 30 days |

## 5. External data / tracking still required

1. Platform-fee ledger (commission, convenience fee, shop subscription, featured listing, ads) with earned vs collected vs settled.
2. Merchant activity events (meaningful owner/staff actions, de-duplicated per day).
3. Salon lifecycle events table + backfill.
4. Booking status-transition history (actor, timestamp, reason).
5. Queue wait-prediction snapshots.
6. Territories, effective-dated sales assignments and targets.
7. Canonical service-category mapping.
8. Discovery / AI-agent / campaign event tracking.

## 6. Scale notes

Phase 1 queries are grouped aggregates over indexed columns (`bookings(salonId, slotStart)`, `bookings(salonId, createdAt)`) with ranges capped at 92 days. The adoption view scans every salon once per request; before ~10k salons this should move to a nightly `salon_daily_metrics` summary table (Phase 3) with an explicit "data as of" time. No latency targets are claimed until measured.
