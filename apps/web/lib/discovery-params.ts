import {
  MAX_WAIT_OPTIONS,
  MIN_RATING_OPTIONS,
  SALON_SEARCH_MAX_IDS,
  SALON_SORT_OPTIONS,
  SERVICE_PRICE_SORTS,
  popularServiceById,
  type SalonSearchSortOption,
  type SalonTypeFilter,
} from "@barbercue/shared";

// URL ⇄ filter state for /search. The URL stays the single source of truth (a shared or bookmarked
// link reproduces the same results); these helpers keep every rule in one testable place.

/** Every query param the search API understands, forwarded as-is. */
export const SEARCH_API_PARAMS = [
  "q", "shopName", "city", "countryCode", "locality", "service", "lat", "lng", "radiusKm",
  "priceMin", "priceMax", "salonType", "popularService", "sort", "minRating", "openNow", "offersOnly", "maxWaitMinutes",
  "minLat", "maxLat", "minLng", "maxLng",
] as const;

/**
 * Distance slider in the filter sidebar: 1–20 km in 1 km steps; the far right end (one step past
 * the maximum) means "Any distance". Any real distance needs the customer's location.
 */
export const DISTANCE_SLIDER_MIN = 1;
export const DISTANCE_SLIDER_MAX = 20;
export const DISTANCE_SLIDER_ANY = DISTANCE_SLIDER_MAX + 1;

/** Slider position → radius in km (null = any distance). */
export function distanceFromSlider(position: number): number | null {
  return position >= DISTANCE_SLIDER_ANY ? null : Math.max(DISTANCE_SLIDER_MIN, Math.round(position));
}

/** Radius in km → slider position (a radius under 1 km from an older link sits at the 1 km end). */
export function sliderFromDistance(km: number | null): number {
  return km === null ? DISTANCE_SLIDER_ANY : Math.min(DISTANCE_SLIDER_MAX, Math.max(DISTANCE_SLIDER_MIN, Math.round(km)));
}

/** "Top rated" means an average review score of at least this. */
export const TOP_RATED_MIN = 4;

export const PRICE_SLIDER_MIN = 0;
export const PRICE_SLIDER_MAX = 2000;
export const PRICE_SLIDER_STEP = 50;

export interface DiscoveryState {
  salonType: SalonTypeFilter | null;
  popularService: string | null;
  legacyService: string | null;
  priceMin: number | null;
  priceMax: number | null;
  sort: SalonSearchSortOption;
  nearMe: boolean;
  minRating: number | null;
  openNow: boolean;
  offersOnly: boolean;
  /** Live queue: maximum estimated wait in minutes (0 = no wait right now), or null for any. */
  maxWait: number | null;
  /** `favorites=1`: only the customer's saved salons (their IDs are sent, never put in the URL). */
  favoritesOnly: boolean;
}

export function readDiscoveryState(params: URLSearchParams): DiscoveryState {
  const salonType = params.get("salonType");
  const sort = params.get("sort");
  const num = (key: string) => {
    const value = params.get(key);
    return value === null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const nearMe = params.has("lat") && params.has("lng");
  return {
    salonType: salonType === "GENTS" || salonType === "LADIES" || salonType === "UNISEX" ? salonType : null,
    popularService: popularServiceById(params.get("popularService"))?.id ?? null,
    legacyService: params.get("service"),
    priceMin: num("priceMin"),
    priceMax: num("priceMax"),
    sort: (SALON_SORT_OPTIONS as readonly string[]).includes(sort ?? "") ? (sort as SalonSearchSortOption) : nearMe ? "distance" : "relevance",
    nearMe,
    minRating: (MIN_RATING_OPTIONS as readonly number[]).includes(num("minRating") ?? NaN) ? num("minRating") : null,
    openNow: params.get("openNow") === "true",
    offersOnly: params.get("offersOnly") === "true",
    maxWait: (MAX_WAIT_OPTIONS as readonly number[]).includes(num("maxWaitMinutes") ?? NaN) ? num("maxWaitMinutes") : null,
    favoritesOnly: params.get("favorites") === "1",
  };
}

/** Price sorts compare the selected service's price; with no service, each salon's starting price. */
export function sortsByStartingPrice(option: SalonSearchSortOption, state: Pick<DiscoveryState, "popularService" | "legacyService">): boolean {
  return SERVICE_PRICE_SORTS.includes(option) && !state.popularService && !state.legacyService;
}

/** Search API query string for the current URL (only known params, empty values dropped). */
export function searchApiQuery(params: URLSearchParams, favoriteIds?: Iterable<string>): string {
  const out = new URLSearchParams();
  for (const key of SEARCH_API_PARAMS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  const state = readDiscoveryState(params);
  if (state.favoritesOnly && favoriteIds) out.set("ids", [...favoriteIds].slice(0, SALON_SEARCH_MAX_IDS).join(","));
  return out.toString();
}

/** Apply changes to the current URL params; null removes a key. Returns the new query string. */
export function withParams(params: URLSearchParams, changes: Record<string, string | null>): string {
  const next = new URLSearchParams(params.toString());
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  return next.toString();
}

/**
 * Switching from one compared service to another (or clearing it) resets the price range — a
 * ₹100–₹300 haircut range means nothing for a facial. Picking a first service keeps a range set
 * for "any service", now applied to that service. A price sort stays (it falls back to starting price).
 */
export function popularServiceChange(params: URLSearchParams, serviceId: string | null): Record<string, string | null> {
  const state = readDiscoveryState(params);
  const keepRange = state.popularService === null && serviceId !== null;
  return {
    popularService: serviceId,
    ...(keepRange ? {} : { priceMin: null, priceMax: null }),
  };
}

/** Slider values → URL values: the slider ends mean "no limit". */
export function priceRangeChange(min: number, max: number): Record<string, string | null> {
  return {
    priceMin: min <= PRICE_SLIDER_MIN ? null : String(min),
    priceMax: max >= PRICE_SLIDER_MAX ? null : String(max),
  };
}

/** Number of active filters, for the mobile "Filters (n)" button and the Clear-all link. */
export function activeFilterCount(state: DiscoveryState): number {
  return [
    state.salonType,
    state.popularService,
    state.legacyService,
    state.priceMin !== null || state.priceMax !== null ? "price" : null,
    state.minRating,
    state.openNow,
    state.offersOnly,
    state.maxWait !== null ? "wait" : null,
    state.favoritesOnly,
  ].filter(Boolean).length;
}
