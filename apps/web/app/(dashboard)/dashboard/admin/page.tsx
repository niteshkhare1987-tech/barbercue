"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ADMIN_PATHS, Role, SalonStatus, type PlatformAdminOverviewDto } from "@barbercue/shared";
import { useAuth } from "../../../../lib/auth-context";
import { apiFetch, ApiError } from "../../../../lib/api";
import { Button, LinkButton } from "../../../../components/ui/Button";
import { ShopActivityPanel } from "../../../../components/admin/ShopActivityPanel";
import styles from "./admin.module.css";

function contact(email: string | null, phone: string | null): string {
  return email ?? phone ?? "Not recorded";
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

export function getNextShopStatus(status: SalonStatus): { status: SalonStatus; label: string } | null {
  if (status === SalonStatus.PENDING) return { status: SalonStatus.ACTIVE, label: "Open shop" };
  if (status === SalonStatus.ACTIVE) return { status: SalonStatus.SUSPENDED, label: "Suspend" };
  if (status === SalonStatus.SUSPENDED) return { status: SalonStatus.ACTIVE, label: "Re-open" };
  return null;
}

export default function AdminDashboardPage() {
  const { user, logout } = useAuth();
  const superAdmin = !!user && user.roles.includes(Role.PLATFORM_ADMIN);
  const coFounder = !!user && user.roles.includes(Role.CO_FOUNDER);
  const hrAdmin = !!user && user.roles.includes(Role.HR_ADMIN);
  const salesAdmin = !!user && user.roles.includes(Role.SALES_ADMIN);
  const readOnlyViewer =
    !!user &&
    user.roles.includes(Role.PLATFORM_VIEWER) &&
    !superAdmin &&
    !coFounder &&
    !hrAdmin &&
    !salesAdmin;
  const maskedOverview = !superAdmin && !coFounder;
  const canManageShops = superAdmin || coFounder;
  const canManageEmployees = superAdmin || coFounder || hrAdmin;
  const canOpenCrm = superAdmin || coFounder || hrAdmin || salesAdmin;
  const canReviewVerification = superAdmin || coFounder;
  const [data, setData] = useState<PlatformAdminOverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shopStatus, setShopStatus] = useState<"ALL" | SalonStatus>("ALL");
  const [deletingShopId, setDeletingShopId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [statusShopId, setStatusShopId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSuccess, setStatusSuccess] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  async function handleStatusChange(shopId: string, shopName: string, currentStatus: SalonStatus) {
    const transition = getNextShopStatus(currentStatus);
    if (!transition || !window.confirm(`${transition.label} "${shopName}"?`)) return;
    setStatusError(null);
    setStatusSuccess(null);
    setStatusShopId(shopId);
    try {
      const result = await apiFetch<{ id: string; status: SalonStatus }>(
        `${ADMIN_PATHS.admin}/${ADMIN_PATHS.shops}/${shopId}/${ADMIN_PATHS.status}`,
        { method: "PATCH", body: JSON.stringify({ status: transition.status }) },
      );
      setData((current) => current ? { ...current, shops: current.shops.map((shop) => shop.id === shopId ? { ...shop, status: result.status } : shop) } : current);
      setStatusSuccess(`${transition.label} completed for ${shopName}.`);
    } catch (requestError) {
      const details = requestError instanceof ApiError && requestError.details && typeof requestError.details === "object"
        ? Object.entries(requestError.details as Record<string, unknown>).filter(([, value]) => value === false).map(([key]) => key.replace(/^hasActive/, "Missing active ").replace(/([A-Z])/g, " $1").trim()).join(", ")
        : "";
      setStatusError(requestError instanceof ApiError ? `${requestError.message}${details ? ` (${details})` : ""}` : "Could not update this shop status.");
    } finally {
      setStatusShopId(null);
    }
  }

  async function handleDeleteShop(shopId: string, shopName: string) {
    if (!window.confirm(`Delete "${shopName}"? This cannot be undone. Only a shop with no staff, bookings, queue, review, or ledger activity can be deleted.`)) {
      return;
    }
    setDeleteError(null);
    setDeletingShopId(shopId);
    try {
      await apiFetch(`${ADMIN_PATHS.admin}/${ADMIN_PATHS.shops}/${shopId}`, { method: "DELETE" });
      setData((current) => current ? { ...current, shops: current.shops.filter((shop) => shop.id !== shopId), counts: { ...current.counts, shops: current.counts.shops - 1 } } : current);
    } catch (requestError) {
      setDeleteError(requestError instanceof ApiError ? requestError.message : "Could not delete this shop.");
    } finally {
      setDeletingShopId(null);
    }
  }

  const loadOverview = useCallback(async (background = false) => {
    if (!background) setRefreshing(true);
    try {
      const overview = await apiFetch<PlatformAdminOverviewDto>(
        `${ADMIN_PATHS.admin}/${ADMIN_PATHS.overview}`,
      );
      setData(overview);
      setError(null);
    } catch (requestError) {
      // A background poll failure must not blank a healthy snapshot; the next poll can retry.
      if (!background) {
        setError(requestError instanceof ApiError ? requestError.message : "Could not load platform monitoring.");
      }
    } finally {
      if (!background) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOverview(true), 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview]);

  // The admin overview used to be a one-time snapshot, so a booking created after the page had
  // opened stayed invisible until a full browser refresh. Poll lightly while this operations page
  // is open so new bookings/cancellations become visible without making the admin guess that the
  // data is stale.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadOverview(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadOverview]);

  const normalizedQuery = query.trim().toLowerCase();
  const shops = useMemo(() => (data?.shops ?? []).filter((shop) =>
    (shopStatus === "ALL" || shop.status === shopStatus) &&
    (!normalizedQuery || `${shop.name} ${shop.publicId} ${shop.ownerEmail ?? ""} ${shop.ownerPhone ?? ""}`.toLowerCase().includes(normalizedQuery)),
  ), [data, normalizedQuery, shopStatus]);
  const staff = useMemo(() => (data?.staff ?? []).filter((member) =>
    !normalizedQuery || `${member.displayName} ${member.salonName} ${member.salonPublicId} ${member.email ?? ""} ${member.phone ?? ""}`.toLowerCase().includes(normalizedQuery),
  ), [data, normalizedQuery]);
  const customers = useMemo(() => (data?.customers ?? []).filter((customer) =>
    !normalizedQuery || `${customer.email ?? ""} ${customer.phone ?? ""} ${customer.id}`.toLowerCase().includes(normalizedQuery),
  ), [data, normalizedQuery]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Role-protected operations</p>
          <h1>Platform operations</h1>
          <p>Monitor FastQue and apply controlled shop support actions. Signed in as {user?.email ?? "platform admin"}.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="outline" onClick={() => { setRefreshToken((n) => n + 1); void loadOverview(); }} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {superAdmin && <LinkButton href="/dashboard/admin/access" variant="outline">Access</LinkButton>}
          {canManageEmployees && <LinkButton href="/dashboard/admin/employees" variant="outline">Employees</LinkButton>}
          {canOpenCrm && <LinkButton href="/dashboard/admin/crm" variant="outline">Field CRM</LinkButton>}
          {canReviewVerification && <LinkButton href="/dashboard/admin/verification" variant="outline">Verification queue</LinkButton>}
          <Button type="button" variant="outline" onClick={() => void logout()}>Log out</Button>
        </div>
      </header>

      {readOnlyViewer && (
        <p className={styles.readOnlyNotice} role="status">
          Read-only access · create, edit, approval, password-reset and deletion actions are disabled.
        </p>
      )}
      {maskedOverview && (
        <p className={styles.readOnlyNotice} role="status">
          Contact details are masked in the broad platform overview. Authorized CRM workflows retain their role-specific access.
        </p>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!data && !error && <p className={styles.loading} role="status">Loading platform activity…</p>}

      {data && (
        <>
          <section className={styles.growthCounters} aria-label="FastQue real growth counters">
            <article className={styles.growthCounter}>
              <div className={styles.growthCounterTopline}>
                <span>Bookings done till now</span>
                <em>LIVE DB</em>
              </div>
              <strong>{formatCount(data.counts.bookings)}</strong>
              <p>All booking records created in FastQue production.</p>
            </article>

            <article className={styles.growthCounter}>
              <div className={styles.growthCounterTopline}>
                <span>People visited fastque.com</span>
                <em>FIRST-PARTY</em>
              </div>
              <strong>{formatCount(data.counts.websiteVisitors)}</strong>
              <p>
                Unique browser/device visitors; obvious bots excluded.
                {data.visitorTrackingStartedAt
                  ? ` Tracking started ${dateTime(data.visitorTrackingStartedAt)}.`
                  : " Tracking is live; no visitor has been recorded yet."}
              </p>
            </article>
          </section>
          <p className={styles.counterTruthNote}>
            Visitor count starts from first-party tracking rollout only—no estimated or fabricated historical backfill.
          </p>

          <section className={styles.metrics} aria-label="Platform totals">
            {Object.entries({
              Shops: data.counts.shops,
              Owners: data.counts.owners,
              Staff: data.counts.staff,
              Customers: data.counts.customers,
              "Live queue": data.counts.liveQueueEntries,
              "Active Premium": data.counts.activePremiumSubscriptions,
            }).map(([label, value]) => (
              <article key={label}><strong>{value}</strong><span>{label}</span></article>
            ))}
          </section>

          <section className={styles.filters} aria-label="Monitoring filters">
            <div>
              <label htmlFor="admin-search">Search shops, IDs, people or contact</label>
              <input id="admin-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Shop ID, salon, email, phone…" />
            </div>
            <div>
              <label htmlFor="admin-shop-status">Shop status</label>
              <select id="admin-shop-status" value={shopStatus} onChange={(event) => setShopStatus(event.target.value as "ALL" | SalonStatus)}>
                <option value="ALL">All statuses</option>
                <option value={SalonStatus.PENDING}>Pending</option>
                <option value={SalonStatus.ACTIVE}>Active</option>
                <option value={SalonStatus.SUSPENDED}>Suspended</option>
              </select>
            </div>
          </section>

          <ShopActivityPanel search={query} refreshToken={refreshToken} />

          <section className={styles.section}>
            <div className={styles.sectionHeader}><h2>Shops</h2><span>{shops.length} shown · latest 100</span></div>
            {deleteError && <p className={styles.error} role="alert">{deleteError}</p>}
            {statusError && <p className={styles.error} role="alert">{statusError}</p>}
            {statusSuccess && <p className={styles.success} role="status">{statusSuccess}</p>}
            <div className={styles.tableWrap}>
              <table><thead><tr><th>Shop</th><th>Status</th><th>Owner</th><th>Operations</th><th>Plan</th><th>Actions</th></tr></thead>
                <tbody>{shops.map((shop) => <tr key={shop.id}>
                  <td><strong>{shop.name}</strong><small>{shop.publicId}</small></td>
                  <td><span className={styles.status}>{shop.status}</span></td>
                  <td>{contact(shop.ownerEmail, shop.ownerPhone)}</td>
                  <td>{shop.staffCount} staff · {shop.bookingCount} bookings · {shop.liveQueueCount} live</td>
                  <td>{shop.subscriptionStatus}</td>
                  <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {!canManageShops ? (
                      <span className={styles.readOnlyBadge}>No shop actions</span>
                    ) : (
                      <>
                        <LinkButton href={`/dashboard/salons/${shop.id}/settings`} variant="secondary">Manage</LinkButton>
                        {getNextShopStatus(shop.status) && (
                          <Button type="button" variant={shop.status === SalonStatus.ACTIVE ? "outline" : "primary"} disabled={statusShopId === shop.id} onClick={() => void handleStatusChange(shop.id, shop.name, shop.status)}>
                            {statusShopId === shop.id ? "Saving…" : getNextShopStatus(shop.status)?.label}
                          </Button>
                        )}
                        <Button type="button" variant="outline" disabled={deletingShopId === shop.id} onClick={() => void handleDeleteShop(shop.id, shop.name)}>
                          {deletingShopId === shop.id ? "Deleting…" : "Delete"}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>)}</tbody>
              </table>
            </div>
            {shops.length === 0 && <p className={styles.empty}>No shops match these filters.</p>}
          </section>

          <div className={styles.twoColumn}>
            <section className={styles.section}>
              <div className={styles.sectionHeader}><h2>Staff</h2><span>{staff.length} shown</span></div>
              <ul className={styles.peopleList}>{staff.map((member) => <li key={member.id}>
                <div><strong>{member.displayName}</strong><small>{member.salonName} · {member.salonPublicId}</small></div>
                <div><span className={styles.status}>{member.status}</span><small>{contact(member.email, member.phone)}</small></div>
              </li>)}</ul>
              {staff.length === 0 && <p className={styles.empty}>No staff match this search.</p>}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeader}><h2>Customers</h2><span>{customers.length} shown</span></div>
              <ul className={styles.peopleList}>{customers.map((customer) => <li key={customer.id}>
                <div><strong>{contact(customer.email, customer.phone)}</strong><small>{customer.bookingCount} bookings · {customer.queueEntryCount} queue visits</small></div>
                <div><span className={styles.status}>{customer.status}</span><small>{customer.isPremium ? "Premium" : "Standard"}</small></div>
              </li>)}</ul>
              {customers.length === 0 && <p className={styles.empty}>No customers match this search.</p>}
            </section>
          </div>

          <section className={styles.section}>
            <div className={styles.sectionHeader}><h2>Recent bookings</h2><span>Latest 50</span></div>
            <div className={styles.activityGrid}>{data.recentBookings.map((booking) => <article key={booking.id}>
              <strong>{booking.salonName} · {booking.serviceName}</strong>
              <span>{booking.status} · {dateTime(booking.slotStart)}</span>
              <small>{contact(booking.customerEmail, booking.customerPhone)}</small>
            </article>)}</div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}><h2>Live & recent queue activity</h2><span>Latest 50</span></div>
            <div className={styles.activityGrid}>{data.recentQueue.map((entry) => <article key={entry.id}>
              <strong>{entry.salonName} · Queue #{entry.tokenNumber}</strong>
              <span>{entry.status} · {dateTime(entry.joinedAt)}{entry.serviceName ? ` · ${entry.serviceName}` : ""}</span>
              <small>{entry.assignedStaffName ?? "Unassigned"}{entry.assignedChairLabel ? ` · ${entry.assignedChairLabel}` : ""}</small>
            </article>)}</div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}><h2>Customer Premium</h2><span>Latest 50 subscriptions</span></div>
            <div className={styles.activityGrid}>{data.premiumSubscriptions.map((subscription) => <article key={subscription.id}>
              <strong>{subscription.planName} · {subscription.status}</strong>
              <span>Period ends {dateTime(subscription.periodEnd)}</span>
              <small>{contact(subscription.customerEmail, subscription.customerPhone)}</small>
            </article>)}</div>
            {data.premiumSubscriptions.length === 0 && <p className={styles.empty}>No Premium subscriptions recorded.</p>}
          </section>

          <p className={styles.generated}>Snapshot generated {dateTime(data.generatedAt)}. Refresh the page for a new read-only snapshot.</p>
        </>
      )}
    </main>
  );
}
