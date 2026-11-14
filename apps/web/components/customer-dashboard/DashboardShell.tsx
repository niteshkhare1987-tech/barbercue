"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCustomerPrefs } from "../../lib/customer-preferences";
import { giftCardsEnabled } from "../../lib/dashboard-flags";
import { DashIcon, type IconName } from "./icons";
import styles from "./dashboard-shell.module.css";

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other paths that should highlight this item. */
  also?: string[];
}

export const PRIMARY_NAV: NavItem[] = [
  { href: "/account", label: "Dashboard", icon: "home" },
  { href: "/account/discover", label: "Discover Salons", icon: "search" },
  { href: "/account/bookings", label: "My Appointments", icon: "calendar" },
  { href: "/account/favorites", label: "My Favourites", icon: "heart" },
  { href: "/account/rewards", label: "Rewards & Gifts", icon: "gift", also: ["/account/credits"] },
  { href: "/account/reviews", label: "My Reviews", icon: "star" },
  { href: "/account/invoices", label: "My Invoices", icon: "invoice" },
  { href: "/account/profile", label: "Settings", icon: "settings" },
];

const SECONDARY_NAV: NavItem[] = [
  { href: "/account/premium", label: "Premium", icon: "crown" },
  { href: "/style-advisor", label: "AI Style Advisor", icon: "sparkle" },
];

const MOBILE_NAV: NavItem[] = [
  { href: "/account", label: "Home", icon: "home" },
  { href: "/account/discover", label: "Discover", icon: "search" },
  { href: "/account/bookings", label: "Bookings", icon: "calendar" },
  { href: "/account/favorites", label: "Favourites", icon: "heart" },
];

const MORE_NAV: NavItem[] = [
  { href: "/account/rewards", label: "Rewards & Gifts", icon: "gift" },
  { href: "/account/reviews", label: "My Reviews", icon: "star" },
  { href: "/account/invoices", label: "My Invoices", icon: "invoice" },
  { href: "/account/profile", label: "Settings", icon: "settings" },
  ...SECONDARY_NAV,
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/account") return pathname === "/account";
  return [item.href, ...(item.also ?? [])].some((href) => pathname === href || pathname.startsWith(`${href}/`));
}

/**
 * Customer dashboard frame: left sidebar (desktop), slim top bar with search + location, and a
 * bottom tab bar on phones. Sits under the existing global SiteHeader (no duplicated global nav).
 */
export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const prefs = useCustomerPrefs();
  const [query, setQuery] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const params = new URLSearchParams();
    const text = query.trim();
    if (text) params.set("shopName", text);
    if (prefs.preferredCity) {
      params.set("city", prefs.preferredCity.slug);
      params.set("countryCode", prefs.preferredCity.countryCode);
    }
    router.push(`/account/discover${params.size ? `?${params}` : ""}`);
  }

  const moreActive = MORE_NAV.some((item) => isActive(pathname, item));

  return (
    <div className={styles.frame}>
      <aside className={styles.sidebar} aria-label="Customer dashboard">
        <nav className={styles.nav}>
          {PRIMARY_NAV.map((item) => (
            <Link key={item.href} href={item.href} className={styles.navLink} aria-current={isActive(pathname, item) ? "page" : undefined}>
              <DashIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className={styles.navDivider} />
        <nav className={styles.nav} aria-label="More from FastQue">
          {SECONDARY_NAV.map((item) => (
            <Link key={item.href} href={item.href} className={`${styles.navLink} ${styles.navLinkQuiet}`} aria-current={isActive(pathname, item) ? "page" : undefined}>
              <DashIcon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
          {/* Separate login surface — see account-shell history; shown to every customer. */}
          <Link href="/owner/login" className={`${styles.navLink} ${styles.navLinkQuiet}`}>
            <DashIcon name="user" />
            <span>Owner Dashboard</span>
          </Link>
        </nav>
        <div className={styles.promo}>
          {giftCardsEnabled() ? (
            <>
              <DashIcon name="gift" size={28} />
              <strong>Gift a Salon Experience</strong>
              <p>Preview how FastQue gift cards will work.</p>
              <Link href="/account/rewards?tab=send">Send Gift Card →</Link>
            </>
          ) : (
            <>
              <DashIcon name="sparkle" size={28} />
              <strong>Find your next look</strong>
              <p>Try styles with the AI Style Advisor, then book in a tap.</p>
              <Link href="/style-advisor">Try it →</Link>
            </>
          )}
        </div>
      </aside>

      <div className={styles.main}>
        <div className={styles.topbar}>
          <form className={styles.search} role="search" onSubmit={submit}>
            <DashIcon name="search" size={18} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search salons by name…"
              aria-label="Search salons by name"
              maxLength={120}
            />
          </form>
          <Link href="/account/profile#location" className={styles.location} title="Change preferred city">
            <DashIcon name="pin" size={18} />
            <span>{prefs.preferredCity ? prefs.preferredCity.name : "Set your city"}</span>
          </Link>
        </div>
        <div className={styles.content}>{children}</div>
      </div>

      <nav className={styles.bottomNav} aria-label="Dashboard">
        {MOBILE_NAV.map((item) => (
          <Link key={item.href} href={item.href} className={styles.bottomLink} aria-current={isActive(pathname, item) ? "page" : undefined} onClick={() => setMoreOpen(false)}>
            <DashIcon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
        <button
          type="button"
          className={styles.bottomLink}
          aria-expanded={moreOpen}
          aria-controls="dashboard-more"
          aria-current={moreActive ? "page" : undefined}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <DashIcon name="more" />
          <span>More</span>
        </button>
      </nav>
      {moreOpen && (
        <div className={styles.moreBackdrop} onClick={() => setMoreOpen(false)}>
          <div id="dashboard-more" className={styles.moreSheet} role="menu" onClick={(e) => e.stopPropagation()}>
            {MORE_NAV.map((item) => (
              <Link key={item.href} href={item.href} role="menuitem" className={styles.moreLink} aria-current={isActive(pathname, item) ? "page" : undefined} onClick={() => setMoreOpen(false)}>
                <DashIcon name={item.icon} />
                <span>{item.label}</span>
                <span aria-hidden="true" className={styles.chev}>›</span>
              </Link>
            ))}
            <Link href="/owner/login" role="menuitem" className={styles.moreLink} onClick={() => setMoreOpen(false)}>
              <DashIcon name="user" />
              <span>Owner Dashboard</span>
              <span aria-hidden="true" className={styles.chev}>›</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
