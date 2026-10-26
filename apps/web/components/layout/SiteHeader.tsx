"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DISCOVERY_PATHS } from "@barbercue/shared";
import type { SalonWorkplaceDto } from "@barbercue/shared";
import { useAuth } from "../../lib/auth-context";
import { apiFetch } from "../../lib/api";
import {
  isWorkspaceUser,
  workspaceLandingPath,
  workspaceNavigationLabel,
} from "../../lib/workspace-route";
import { BrandLockup } from "../ui/BrandLockup";
import { NotificationBell } from "./NotificationBell";
import { CloseIcon, LocationIcon, MenuIcon } from "../landing/icons";
import styles from "../landing/landing.module.css";

const SALON_SCOPED_PATH = /^\/dashboard\/salons\/([^/]+)(\/.*)?$/;
// The owner/staff shell (components/owner/OwnerShell) supplies its own header on these routes.
const OWNER_SHELL_PATH = SALON_SCOPED_PATH;

const PRIMARY_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  aboutOnly?: boolean;
}> = [
  { href: "/search", label: "Find a barber" },
  { href: "/#services", label: "Services" },
  { href: "/#book-or-queue", label: "How it works" },
  { href: "/#for-shops", label: "For shops" },
  { href: "/about-us", label: "About Us", aboutOnly: true },
];

export function SiteHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, status } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileNavId = useId();
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  const [workplaces, setWorkplaces] = useState<SalonWorkplaceDto[] | null>(null);

  const authenticatedUser = status === "authenticated" ? user : null;
  const workspaceUser =
    authenticatedUser && isWorkspaceUser(authenticatedUser) ? authenticatedUser : null;

  const salonMatch = pathname.match(SALON_SCOPED_PATH);
  const currentSalonId = salonMatch?.[1] ?? null;
  const restOfSalonPath = salonMatch?.[2] ?? "";

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!currentSalonId) {
      setWorkplaces(null);
      return;
    }
    let cancelled = false;
    apiFetch<SalonWorkplaceDto[]>(`${DISCOVERY_PATHS.salons}/${DISCOVERY_PATHS.workplaces}`)
      .then((list) => {
        if (!cancelled) setWorkplaces(list);
      })
      .catch(() => {
        if (!cancelled) setWorkplaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentSalonId]);

  const ownedShops = useMemo(
    () => (workplaces ?? []).filter((workplace) => workplace.isOwner),
    [workplaces],
  );
  const showShopSwitcher = currentSalonId !== null && ownedShops.length > 1;

  const workspaceHref = authenticatedUser
    ? workspaceLandingPath(authenticatedUser)
    : "/login";
  const workspaceLabel = authenticatedUser
    ? workspaceNavigationLabel(authenticatedUser)
    : "Sign In";
  const showListShop = !workspaceUser;

  // Inside the owner/staff dashboard the shell renders its own header (after all hooks above ran).
  if (OWNER_SHELL_PATH.test(pathname)) return null;

  const closeMobileMenu = () => setMobileOpen(false);

  // Disclosure pattern: Escape from the toggle or any menu item closes the menu and puts focus back
  // on the toggle, so keyboard users are not left inside a menu that has disappeared.
  function handleMobileNavKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !mobileOpen) return;
    event.preventDefault();
    setMobileOpen(false);
    menuToggleRef.current?.focus();
  }

  function ShopSwitcher({ mobile = false }: { mobile?: boolean }) {
    if (!showShopSwitcher) return null;
    return (
      <select
        aria-label="Switch shop"
        value={currentSalonId ?? ""}
        onChange={(event) =>
          router.push(`/dashboard/salons/${event.target.value}${restOfSalonPath}`)
        }
        className={mobile ? styles.siteShopSwitcherMobile : styles.siteShopSwitcher}
      >
        {ownedShops.map((shop) => (
          <option key={shop.id} value={shop.id}>
            {shop.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <>
      <header className={styles.landingHeader}>
        <div className={styles.hiringBar}>
          <Link href="/careers" className={styles.hiringInner} aria-label="FastQue is hiring — view open field sales role">
            <span className={styles.hiringBadge}>We&apos;re hiring</span>
            <span className={styles.hiringText}>
              Field Sales &amp; Shop Onboarding · No experience required · ₹10k–₹12k/month on target
            </span>
            <span className={styles.hiringCta}>View role <span aria-hidden="true">→</span></span>
          </Link>
        </div>

        <div className={styles.utilityBar}>
          <div className={styles.utilityInner}>
            <div className={styles.utilityLeft}>
              <span className={styles.locationChip}>
                <LocationIcon className={styles.locationIcon} />
                India
              </span>
              <span className={styles.utilityTagline}>
                Good Looks<span className={styles.utilityDot} aria-hidden="true" />Less Waiting
              </span>
            </div>

            <div className={styles.utilityRight}>
              <Link href="/employee/login">Employee Login</Link>
              <Link href="/about-us">About Us</Link>
              <Link href="/contact-us">Contact Us</Link>
              <Link href="/careers">Careers</Link>
              <Link href="/#book-or-queue">For Customers</Link>
              <Link href="/#for-shops">For Shops</Link>
              <Link href="/dashboard/register-shop">Partner With Us</Link>
              <ShopSwitcher />
              {authenticatedUser && <NotificationBell />}
              <span className={styles.utilityDivider} aria-hidden="true" />
              <div className={styles.utilityAuth}>
                <Link href={workspaceHref} className={styles.utilityLink}>
                  {authenticatedUser ? workspaceLabel : "Login"}
                </Link>
                {!authenticatedUser && (
                  <Link href="/login" className={styles.utilityCta}>
                    Sign Up
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className={styles.mainNavBar}>
          <div className={styles.headerInner}>
            <Link href="/" className={styles.wordmark} aria-label="FastQue home">
              <BrandLockup transparent headerArtwork />
            </Link>

            <nav className={styles.headerNav} aria-label="Primary">
              {PRIMARY_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={
                    (link.href === "/search" && pathname === "/search") ||
                    (link.href === "/about-us" && pathname === "/about-us")
                      ? styles.headerNavActive
                      : link.aboutOnly
                        ? styles.headerNavAbout
                        : undefined
                  }
                >
                  {link.label}
                </Link>
              ))}
            </nav>

            <div className={styles.headerWideRow}>
              <ShopSwitcher />
              {authenticatedUser && <NotificationBell />}
              <Link href={workspaceHref} className={styles.headerSignIn}>
                {workspaceLabel}
              </Link>
              {showListShop && (
                <Link href="/dashboard/register-shop" className={styles.headerCta}>
                  List Your Shop
                </Link>
              )}
            </div>

            {authenticatedUser && (
              <div className={styles.siteMobileBell}>
                <NotificationBell />
              </div>
            )}

            <div className={styles.mobileNavHost} onKeyDown={handleMobileNavKeyDown}>
              <button
                ref={menuToggleRef}
                type="button"
                className={styles.menuToggle}
                aria-label={mobileOpen ? "Close menu" : "Open menu"}
                aria-expanded={mobileOpen}
                aria-controls={mobileNavId}
                onClick={() => setMobileOpen((open) => !open)}
              >
                {mobileOpen ? <CloseIcon /> : <MenuIcon />}
              </button>

              {mobileOpen && (
                <nav id={mobileNavId} className={styles.mobileNav} aria-label="Mobile">
                  {PRIMARY_LINKS.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={styles.mobileNavLink}
                      onClick={closeMobileMenu}
                    >
                      {link.label}
                    </Link>
                  ))}
                  <Link href="/employee/login" className={styles.mobileNavLink} onClick={closeMobileMenu}>
                    Employee Login
                  </Link>
                  <Link href="/contact-us" className={styles.mobileNavLink} onClick={closeMobileMenu}>
                    Contact Us
                  </Link>
                  <Link href="/careers" className={styles.mobileNavLink} onClick={closeMobileMenu}>
                    We&apos;re Hiring
                  </Link>
                  <ShopSwitcher mobile />
                  <div className={styles.mobileNavDivider} aria-hidden="true" />
                  <Link
                    href={workspaceHref}
                    className={styles.mobileNavLink}
                    onClick={closeMobileMenu}
                  >
                    {workspaceLabel}
                  </Link>
                  {showListShop && (
                    <Link
                      href="/dashboard/register-shop"
                      className={styles.mobileNavCta}
                      onClick={closeMobileMenu}
                    >
                      List your shop
                    </Link>
                  )}
                </nav>
              )}
            </div>
          </div>
        </div>
      </header>
      <div className={styles.siteHeaderSpacer} aria-hidden="true" />
    </>
  );
}
