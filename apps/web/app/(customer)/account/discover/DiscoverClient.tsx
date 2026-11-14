"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import SearchClient from "../../../(public)/search/SearchClient";
import { RecentlyViewedList } from "../../../../components/customer-dashboard/RecentlyViewedList";
import { useFavorites } from "../../../../lib/favorites";
import styles from "../../../../components/customer-dashboard/dash.module.css";

const BASE = "/account/discover";

/**
 * Discover = the exact same search as the public Find Salons page (SearchClient, GET salons, same
 * URL filters and rules), mounted inside the dashboard with List/Map view enabled. "Favourites" is
 * that search's existing favourites-only filter; "Recently viewed" is the customer's own history.
 */
export default function DiscoverClient() {
  const params = useSearchParams();
  const { savedIds, loaded } = useFavorites();
  const tab = params.get("tab") === "recent" ? "recent" : params.get("favorites") === "1" ? "favourites" : "all";

  function hrefFor(next: "all" | "favourites" | "recent") {
    const p = new URLSearchParams(params.toString());
    p.delete("tab");
    p.delete("favorites");
    if (next === "favourites") p.set("favorites", "1");
    if (next === "recent") return `${BASE}?tab=recent`;
    return `${BASE}${p.size ? `?${p}` : ""}`;
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Discover Salons</h1>
          <p className={styles.sub}>Search services, compare prices and book — on a list or a map.</p>
        </div>
      </div>
      <nav className={styles.tabs} aria-label="Discover">
        <Link href={hrefFor("all")} className={styles.tab} aria-current={tab === "all" ? "page" : undefined}>All Salons</Link>
        <Link href={hrefFor("favourites")} className={styles.tab} aria-current={tab === "favourites" ? "page" : undefined}>
          Favourites {loaded && <span className={styles.count}>({savedIds.size})</span>}
        </Link>
        <Link href={hrefFor("recent")} className={styles.tab} aria-current={tab === "recent" ? "page" : undefined}>Recently Viewed</Link>
      </nav>
      {tab === "recent" ? <RecentlyViewedList /> : <SearchClient basePath={BASE} enableMap embedded />}
    </div>
  );
}
