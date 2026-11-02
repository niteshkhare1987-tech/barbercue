"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  CityDto,
  CitySearchResultDto,
  PaginatedResult,
  SalonListItemDto,
  SalonSortOption,
} from "@barbercue/shared";
import { DISCOVERY_PATHS, POPULAR_SERVICES, formatPriceFilterLabel, popularServiceById } from "@barbercue/shared";
import { SERVICE_CATEGORIES } from "../../../lib/editorial/manifest";
import { SalonResultCard } from "../../../components/discovery/SalonResultCard";
import { CompareTable, FiltersPanel, SortControl } from "../../../components/discovery/DiscoveryFilters";
import {
  activeFilterCount,
  popularServiceChange,
  readDiscoveryState,
  searchApiQuery,
  withParams,
} from "../../../lib/discovery-params";
import { ServiceNameSearchField } from "../../../components/discovery/ServiceNameSearchField";
import { Button } from "../../../components/ui/Button";
import { apiFetch } from "../../../lib/api";
import { useFavorites } from "../../../lib/favorites";
import styles from "./search.module.css";

// The filter sidebar sits below the fixed site header (152px, see landing.module.css .siteHeaderSpacer).
const SIDEBAR_TOP = 168;
const SIDEBAR_BOTTOM_GAP = 16;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api/v1";

export default function SearchClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(searchParams.get("serviceName") ?? "");
  const [selectedCity, setSelectedCity] = useState<CitySearchResultDto | null>(null);
  // Every city with at least one active salon (GET cities) — customers pick from where FastQue
  // actually has salons, never from a global catalogue full of cities with no results.
  const [salonCities, setSalonCities] = useState<CityDto[] | null>(null);
  const [results, setResults] = useState<SalonListItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const styleName = searchParams.get("style") ?? undefined;
  const nearMeActive = searchParams.has("lat") && searchParams.has("lng");

  // Part 8/9 correction — URL params are the source of truth (same pattern as q/city/lat/lng
  // above), so a shared/bookmarked search link reproduces the exact same filtered results.
  const radiusKmParam = searchParams.get("radiusKm");
  const activeRadiusKm = radiusKmParam !== null ? Number(radiusKmParam) : null;
  const priceMinParam = searchParams.get("priceMin");
  const priceMaxParam = searchParams.get("priceMax");
  const activePriceMin = priceMinParam !== null ? Number(priceMinParam) : null;
  const activePriceMax = priceMaxParam !== null ? Number(priceMaxParam) : null;
  const activeService = searchParams.get("service");
  const activeServiceCategory = SERVICE_CATEGORIES.find((category) => category.query === activeService);
  // Discovery upgrade: salon type, popular-service comparison, price slider and sort (all in the URL).
  const discovery = readDiscoveryState(searchParams);
  const comparedService = popularServiceById(discovery.popularService);
  const view = comparedService && searchParams.get("view") === "compare" ? "compare" : "cards";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const filterCount = activeFilterCount(discovery);
  // The sidebar never scrolls inside itself. If it fits on screen it stays pinned under the header;
  // if it is taller, it scrolls with the page and then stays put once its bottom reaches the
  // bottom of the screen (a negative sticky top), so every option is reachable by page scrolling.
  const asideRef = useRef<HTMLElement>(null);
  const [asideTop, setAsideTop] = useState(SIDEBAR_TOP);
  useEffect(() => {
    const aside = asideRef.current;
    if (!aside || typeof ResizeObserver === "undefined") return undefined;
    const update = () => setAsideTop(Math.min(SIDEBAR_TOP, window.innerHeight - aside.offsetHeight - SIDEBAR_BOTTOM_GAP));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(aside);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  // "My favorites" sends the customer's saved salon IDs to the public search; until they are known
  // (or when signed out / nothing saved) there is nothing to search.
  const { savedIds, loaded: favoritesLoaded, isCustomer, ready: authReady } = useFavorites();
  const favoritesGate: "wait" | "signin" | "empty" | null = !discovery.favoritesOnly
    ? null
    : !authReady
      ? "wait"
      : !isCustomer
        ? "signin"
        : !favoritesLoaded
          ? "wait"
          : savedIds.size === 0
            ? "empty"
            : null;
  const favoriteKey = discovery.favoritesOnly ? [...savedIds].sort().join(",") : "";

  function applyChanges(changes: Record<string, string | null>) {
    const { __popularService, ...rest } = changes;
    const switchesService = "__popularService" in changes;
    const all: Record<string, string | null> = switchesService
      ? { ...popularServiceChange(searchParams, __popularService ?? null), ...rest }
      : rest;
    if (switchesService && __popularService === null) all.view = null;
    const query = withParams(searchParams, all);
    router.push(`/search${query ? `?${query}` : ""}`);
  }

  function clearAllFilters() {
    applyChanges({
      salonType: null, __popularService: null, service: null, priceMin: null, priceMax: null, view: null,
      minRating: null, openNow: null, offersOnly: null, maxWaitMinutes: null, favorites: null,
    });
  }

  // Shared by handleNearMe and selectRadius below — both need "ask the browser for a position,
  // then either apply it directly or bail out with the same locationError copy".
  function requestLocationThen(onSuccess: (lat: number, lng: number) => void) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationError("Location isn't available in this browser. Try searching by city instead.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onSuccess(position.coords.latitude, position.coords.longitude);
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. Try searching by city instead."
            : "Couldn't get your location. Try searching by city instead.",
        );
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 },
    );
  }

  // Distance is visible before "Near me" has ever been pressed (owner-reported discoverability
  // fix) — picking an actual radius here is itself a request for location, applied in one step,
  // rather than requiring a separate prior tap on "Near me". "Any distance" needs no location (it
  // is a no-op once one isn't already set) and never triggers the geolocation prompt.
  function selectRadius(value: number | null) {
    if (!nearMeActive && value !== null) {
      requestLocationThen((lat, lng) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set("lat", String(lat));
        params.set("lng", String(lng));
        params.set("radiusKm", String(value));
        router.push(`/search?${params.toString()}`);
      });
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    if (value === null) params.delete("radiusKm");
    else params.set("radiusKm", String(value));
    router.push(`/search?${params.toString()}`);
  }

  function selectSort(sort: SalonSortOption) {
    if (sort === "distance" && !nearMeActive) {
      requestLocationThen((lat, lng) => applyChanges({ lat: String(lat), lng: String(lng), sort: "distance" }));
      return;
    }
    applyChanges({ sort: sort === "relevance" ? null : sort });
  }

  useEffect(() => {
    apiFetch<CityDto[]>(DISCOVERY_PATHS.cities)
      .then((cities) => {
        setSalonCities([...cities].sort((a, b) => a.name.localeCompare(b.name)));
        // Keep a city that is already in the link selected.
        const fromLink = cities.find((c) => c.slug === new URLSearchParams(window.location.search).get("city"));
        if (fromLink) setSelectedCity({ id: fromLink.id, name: fromLink.name, slug: fromLink.slug, countryCode: fromLink.countryCode, region: null });
      })
      .catch(() => setSalonCities([]));
  }, []);

  useEffect(() => {
    // city/countryCode already arrive as real slugs/codes here (from CitySearchField's own
    // selection, or a shared/bookmarked URL) — no client-side normalization needed or safe to do.
    const params = new URLSearchParams(searchApiQuery(searchParams, favoriteKey ? favoriteKey.split(",") : undefined));

    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        if (favoritesGate) {
          setResults([]);
          setHasMore(false);
          setError(null);
          setLoading(favoritesGate === "wait");
          return undefined;
        }
        setLoading(true);
        setError(null);
        return fetch(`${API_BASE_URL}/${DISCOVERY_PATHS.salons}?${params.toString()}`);
      })
      .then((response) => {
        if (!response) return undefined;
        if (!response.ok) throw new Error(`Search failed with ${response.status}`);
        return response.json() as Promise<PaginatedResult<SalonListItemDto>>;
      })
      .then((data) => {
        if (!cancelled && data) {
          setResults(data.items);
          setHasMore(data.nextCursor !== null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("We couldn’t load shops right now. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [retryKey, searchParams, favoritesGate, favoriteKey]);

  function handleSubmit(event?: React.FormEvent, explicitService?: string) {
    event?.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const serviceName = (explicitService ?? q).trim();
    // The Service input only narrows which salons are shown; preserve the separate popular-service,
    // price and distance filters. A legacy homepage "q" query must not quietly AND with it.
    params.delete("q");
    if (serviceName) params.set("serviceName", serviceName);
    else params.delete("serviceName");
    if (selectedCity) {
      params.set("city", selectedCity.slug);
      params.set("countryCode", selectedCity.countryCode);
    } else if (salonCities) {
      // "All cities" really means any city.
      params.delete("city");
      params.delete("countryCode");
    }
    if (styleName) params.set("style", styleName);
    router.push(`/search${params.size ? `?${params.toString()}` : ""}`);
  }

  // "Near Me" (Phase 4) — the browser's own Geolocation API, no paid Maps/geocoding SDK. On
  // denial/unavailability this degrades gracefully to the existing city/text search rather than
  // blocking the page; nothing here claims a location the browser didn't actually provide.
  function handleNearMe() {
    requestLocationThen((lat, lng) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("lat", String(lat));
      params.set("lng", String(lng));
      router.push(`/search?${params.toString()}`);
    });
  }

  function clearNearMe() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("lat");
    params.delete("lng");
    // radiusKm is meaningless without a query point (see salonSearchQuerySchema's own doc
    // comment) — dropped here too so it doesn't linger as a dead param a shared link would carry.
    params.delete("radiusKm");
    router.push(`/search${params.size ? `?${params.toString()}` : ""}`);
  }

  return (
    <main className={styles.page}>
      <section className={styles.intro} aria-labelledby="search-heading">
        <div className={styles.heroCopy}>
          <h1 id="search-heading">
            Look Good. <span className={styles.heroAccent}>Book Fast.</span>
          </h1>
          <p className={styles.lead}>
            Compare salon services, prices, offers and reviews. Find your perfect salon in minutes.
          </p>
        </div>

        <form className={styles.searchForm} onSubmit={handleSubmit} role="search">
          <div className={styles.field}>
            <span id="search-q-label">Service</span>
            <ServiceNameSearchField
              value={q}
              onChange={setQ}
              onSubmit={(serviceName) => handleSubmit(undefined, serviceName)}
              labelledBy="search-q-label"
            />
          </div>
          <div className={styles.field}>
            <span id="search-city-label">City / location</span>
            {salonCities ? (
              <select
                className={styles.citySelect}
                aria-labelledby="search-city-label"
                value={selectedCity?.slug ?? ""}
                onChange={(event) => {
                  const city = salonCities.find((c) => c.slug === event.target.value);
                  setSelectedCity(city ? { id: city.id, name: city.name, slug: city.slug, countryCode: city.countryCode, region: null } : null);
                }}
              >
                <option value="">{salonCities.length ? "All cities" : "No cities yet"}</option>
                {salonCities.map((city) => (
                  <option key={city.id} value={city.slug}>{city.name}{city.state ? `, ${city.state}` : ""}</option>
                ))}
              </select>
            ) : (
              <input type="search" placeholder="Loading cities…" disabled />
            )}
          </div>
          <Button type="button" variant="outline" className={styles.outlineOnDark} onClick={nearMeActive ? clearNearMe : handleNearMe} disabled={locating} aria-pressed={nearMeActive}>
            {locating ? "Locating…" : nearMeActive ? "Near me ✓" : "Near me"}
          </Button>
          <Button type="submit" variant="primary">
            Find salons
          </Button>
        </form>
        {locationError && <p className={styles.locationNotice}>{locationError}</p>}

        <div className={styles.serviceStrip} role="group" aria-label="Popular services">
          <span className={styles.serviceStripLabel}>Popular services:</span>
          {POPULAR_SERVICES.map((service) => {
            const on = discovery.popularService === service.id;
            return (
              <button
                key={service.id}
                type="button"
                aria-pressed={on}
                className={`${styles.serviceChip} ${on ? styles.serviceChipOn : ""}`}
                onClick={() => applyChanges({ __popularService: on ? null : service.id })}
              >
                {service.label}
              </button>
            );
          })}
        </div>
      </section>

      {styleName && (
        <aside className={styles.styleNotice}>
          <span aria-hidden="true">✦</span>
          <p>
            Your <strong>{styleName}</strong> inspiration is ready. Choose a shop and we’ll carry it
            into booking.
          </p>
        </aside>
      )}

      <div className={styles.discoveryLayout}>
      <aside
        id="discovery-filters"
        ref={asideRef}
        style={{ top: asideTop }}
        className={`${styles.filtersAside} ${filtersOpen ? styles.filtersAsideOpen : ""}`}
        aria-label="Search filters"
      >
        <FiltersPanel
          state={discovery}
          onChange={applyChanges}
          onClearAll={clearAllFilters}
          activeCount={filterCount}
          location={{
            nearMe: nearMeActive,
            radiusKm: activeRadiusKm,
            locating,
            onRadius: selectRadius,
            onNearMe: (on) => (on ? handleNearMe() : clearNearMe()),
          }}
        />
      </aside>
      <section className={styles.results} aria-labelledby="results-heading" aria-live="polite">
        {(activeService || ((activePriceMin !== null || activePriceMax !== null) && !comparedService)) && (
          <div className={styles.activeChips} aria-label="Other active filters">
            {activeService && (
              <button type="button" className={styles.activeChip} onClick={() => applyChanges({ service: null })}>
                Category: {activeServiceCategory?.label ?? activeService} <span aria-hidden="true">×</span>
                <span className={styles.srOnlyText}> (remove)</span>
              </button>
            )}
            {(activePriceMin !== null || activePriceMax !== null) && !comparedService && (
              <button type="button" className={styles.activeChip} onClick={() => applyChanges({ priceMin: null, priceMax: null })}>
                {formatPriceFilterLabel(activePriceMin, activePriceMax)}{activeService ? "" : " (any service)"} <span aria-hidden="true">×</span>
                <span className={styles.srOnlyText}> (remove)</span>
              </button>
            )}
          </div>
        )}
        <div className={styles.resultsHeading}>
          <h2 id="results-heading" className={styles.resultsTitle}>
            {loading
              ? "Finding salons…"
              : error
                ? "Salons unavailable"
                : (
                  <>
                    {results.length}{hasMore ? "+" : ""} {results.length === 1 ? "salon" : "salons"} found
                    {comparedService && <> for <span className={styles.heroAccent}>{comparedService.label}</span></>}
                  </>
                )}
          </h2>
          <div className={styles.resultsTools}>
            <button type="button" className={styles.filtersToggle} aria-expanded={filtersOpen} aria-controls="discovery-filters" onClick={() => setFiltersOpen((open) => !open)}>
              Filters{filterCount > 0 ? ` (${filterCount})` : ""}
            </button>
            <SortControl state={discovery} onChange={selectSort} />
            {comparedService && (
              <div className={styles.viewToggle} role="group" aria-label="Result view">
                <button type="button" aria-pressed={view === "cards"} onClick={() => applyChanges({ view: null })}>Cards</button>
                <button type="button" aria-pressed={view === "compare"} onClick={() => applyChanges({ view: "compare" })}>Compare prices</button>
              </div>
            )}
          </div>
        </div>

        {loading && (
          <div className={styles.grid} aria-label="Loading shops" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div className={styles.skeleton} key={item} aria-hidden="true">
                <span />
                <i />
                <i />
              </div>
            ))}
          </div>
        )}

        {!loading && error && (
          <div className={styles.stateCard} role="alert">
            <span className={styles.stateIcon} aria-hidden="true">!</span>
            <h2>Search hit a snag</h2>
            <p>{error}</p>
            <Button type="button" variant="secondary" onClick={() => setRetryKey((key) => key + 1)}>
              Try again
            </Button>
          </div>
        )}

        {!loading && favoritesGate === "signin" && (
          <div className={styles.stateCard}>
            <span className={styles.stateIcon} aria-hidden="true">♡</span>
            <h2>Sign in to see your favorite salons</h2>
            <p>Your saved salons are kept in your customer account.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push(`/login?next=${encodeURIComponent(`/search?${searchParams.toString()}`)}`)}
            >
              Sign in
            </Button>
          </div>
        )}
        {!loading && favoritesGate === "empty" && (
          <div className={styles.stateCard}>
            <span className={styles.stateIcon} aria-hidden="true">♡</span>
            <h2>No favorite salons yet</h2>
            <p>Tap the heart on any salon to save it, then come back here to compare them.</p>
            <Button type="button" variant="secondary" onClick={() => applyChanges({ favorites: null })}>
              Show all salons
            </Button>
          </div>
        )}

        {!loading && !error && !favoritesGate && results.length === 0 && (
          <div className={styles.stateCard}>
            <span className={styles.stateIcon} aria-hidden="true">⌖</span>
            <h2>No shops match that search yet</h2>
            <p>
              {comparedService && (discovery.priceMin !== null || discovery.priceMax !== null)
                ? `No salon's ${comparedService.label.toLowerCase()} is priced in that range. Try widening the price range.`
                : comparedService
                  ? `No salon here lists ${comparedService.label.toLowerCase()} yet. Try another service or clear the filters.`
                  : "Try a nearby city, a broader service, or clear one of your search terms."}
            </p>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setQ("");
                setSelectedCity(null);
                router.push("/search");
              }}
            >
              Clear search
            </Button>
          </div>
        )}

        {!loading && !error && results.length > 0 && view === "compare" && comparedService && (
          <CompareTable salons={results} serviceLabel={comparedService.label} />
        )}
        {!loading && !error && results.length > 0 && view === "cards" && (
          <div className={styles.cardList}>
            {results.map((salon) => (
              <SalonResultCard key={salon.id} salon={salon} styleName={styleName} />
            ))}
          </div>
        )}
        {!loading && !error && results.length > 0 && <p className={styles.availabilityNote}>Real availability appears when you book.</p>}
      </section>
      </div>
    </main>
  );
}
