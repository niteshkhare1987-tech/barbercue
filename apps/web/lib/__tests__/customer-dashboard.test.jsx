// Customer dashboard helpers: map clustering, share links, recently viewed, preferences, rewards totals,
// favourites sorting and the search-param contract (map bounds forwarded, view-only params not).
import { CreditTransactionType, salonSearchQuerySchema } from "@barbercue/shared";
import { CLUSTER_MAX_ZOOM, boundsOf, clusterPoints, roundBounds } from "../map-cluster";
import { salonProfilePath, salonShareTargets, salonShareUrl } from "../salon-share";
import { GUEST_RECENT_LIMIT, lastViewedLabel, parseRecent, pushRecent } from "../recently-viewed";
import { parsePrefs } from "../customer-preferences";
import { summarizeCredits } from "../rewards-summary";
import { sortFavorites } from "../favorites";
import { searchApiQuery } from "../discovery-params";
import { giftCardsEnabled } from "../dashboard-flags";

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("clusterPoints", () => {
  // Three salons within a few hundred metres in Ghaziabad, one far away in Indore.
  const points = [
    { id: "a", lat: 28.6692, lng: 77.4538 },
    { id: "b", lat: 28.6699, lng: 77.4545 },
    { id: "c", lat: 28.6701, lng: 77.4531 },
    { id: "d", lat: 22.7196, lng: 75.8577 },
  ];

  it("groups nearby salons at city zoom so pins never overlap", () => {
    const clusters = clusterPoints(points, 11);
    const big = clusters.find((c) => c.items.length === 3);
    expect(big).toBeDefined();
    expect(big.key.startsWith("c:")).toBe(true);
    expect(clusters.find((c) => c.items[0].id === "d").key).toBe("p:d");
    expect(clusters.reduce((n, c) => n + c.items.length, 0)).toBe(4);
  });

  it("splits into individual pins at street zoom", () => {
    expect(clusterPoints(points, CLUSTER_MAX_ZOOM)).toHaveLength(4);
  });

  it("ignores salons without valid coordinates", () => {
    expect(clusterPoints([{ id: "x", lat: NaN, lng: 1 }], 10)).toEqual([]);
  });

  it("computes and rounds bounds", () => {
    expect(boundsOf([])).toBeNull();
    const b = boundsOf(points);
    expect(b).toEqual({ minLat: 22.7196, maxLat: 28.6701, minLng: 75.8577, maxLng: 77.4545 });
    expect(roundBounds({ minLat: 28.123456, maxLat: 28.2, minLng: 77.987654, maxLng: 78 })).toEqual({
      minLat: "28.1235", maxLat: "28.2", minLng: "77.9877", maxLng: "78",
    });
  });
});

describe("salon share links", () => {
  const salon = { name: "Vida Salon", slug: "vida-salon", citySlug: "ghaziabad", countryCode: "IN" };

  it("uses the canonical public salon route and nothing private", () => {
    expect(salonProfilePath(salon)).toBe("/in/ghaziabad/vida-salon");
    expect(salonShareUrl(salon, "https://fastque.com/")).toBe("https://fastque.com/in/ghaziabad/vida-salon");
  });

  it("builds supported share intents", () => {
    const url = "https://fastque.com/in/ghaziabad/vida-salon";
    const t = salonShareTargets(salon, url);
    expect(t.whatsapp.startsWith("https://wa.me/?text=")).toBe(true);
    expect(decodeURIComponent(t.whatsapp)).toContain(url);
    expect(t.facebook).toBe(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
    expect(t.x).toContain(`url=${encodeURIComponent(url)}`);
  });
});

describe("recently viewed (guest, this browser only)", () => {
  const now = new Date("2026-11-13T12:00:00Z");

  it("puts the latest first without duplicates and caps the list", () => {
    let list = [];
    for (let i = 0; i < GUEST_RECENT_LIMIT + 5; i += 1) list = pushRecent(list, ID(i), now);
    list = pushRecent(list, ID(GUEST_RECENT_LIMIT + 2), now);
    expect(list).toHaveLength(GUEST_RECENT_LIMIT);
    expect(list[0].id).toBe(ID(GUEST_RECENT_LIMIT + 2));
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
  });

  it("rejects tampered storage", () => {
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent(JSON.stringify([{ id: "../../x", viewedAt: "x" }, { id: ID(1), viewedAt: "2026-01-01" }]))).toEqual([
      { id: ID(1), viewedAt: "2026-01-01" },
    ]);
  });

  it("labels view times", () => {
    expect(lastViewedLabel("2026-11-13T11:59:40Z", now)).toBe("Just now");
    expect(lastViewedLabel("2026-11-13T11:30:00Z", now)).toBe("30 min ago");
    expect(lastViewedLabel("2026-11-08T12:00:00Z", now)).toMatch(/days ago/);
  });
});

describe("customer preferences", () => {
  it("accepts a well-formed city and rejects anything else", () => {
    expect(parsePrefs(JSON.stringify({ preferredCity: { slug: "ghaziabad", name: "Ghaziabad", countryCode: "IN" } }))).toEqual({
      preferredCity: { slug: "ghaziabad", name: "Ghaziabad", countryCode: "IN" },
    });
    expect(parsePrefs(JSON.stringify({ preferredCity: { slug: "<script>", name: "x", countryCode: "IN" } }))).toEqual({ preferredCity: null });
    expect(parsePrefs("{")).toEqual({ preferredCity: null });
  });
});

describe("summarizeCredits", () => {
  const now = new Date("2026-11-13T00:00:00Z");
  it("totals the ledger by type and finds credits expiring in 30 days", () => {
    const rows = [
      { id: "1", type: CreditTransactionType.PROMO_GRANT, amount: 100, remainingAmount: 60, expiresAt: "2026-11-30T00:00:00Z" },
      { id: "2", type: CreditTransactionType.PROMO_GRANT, amount: 50, remainingAmount: 50, expiresAt: "2027-06-01T00:00:00Z" },
      { id: "3", type: CreditTransactionType.REDEEMED, amount: 40, remainingAmount: null, expiresAt: null },
      { id: "4", type: CreditTransactionType.PROMO_GRANT, amount: 20, remainingAmount: 20, expiresAt: "2026-11-01T00:00:00Z" },
    ];
    expect(summarizeCredits(rows, now)).toEqual({ earned: 170, redeemed: 40, expiringSoon: 60 });
  });
});

describe("sortFavorites", () => {
  const base = { ratingCount: 1, favoritedAt: "2026-01-01" };
  const items = [
    { ...base, name: "B", ratingAverage: 4, priceMin: 300, distanceKm: 5 },
    { ...base, name: "A", ratingAverage: null, priceMin: null, distanceKm: null },
    { ...base, name: "C", ratingAverage: 4.8, priceMin: 150, distanceKm: 1.2 },
  ];
  it("orders by nearest and by lowest starting price, unknowns last", () => {
    expect(sortFavorites(items, "nearest").map((i) => i.name)).toEqual(["C", "B", "A"]);
    expect(sortFavorites(items, "price").map((i) => i.name)).toEqual(["C", "B", "A"]);
    expect(sortFavorites(items, "rating").map((i) => i.name)).toEqual(["C", "B", "A"]);
  });
});

describe("search API params (Discover reuses the /search contract)", () => {
  it("forwards map bounds but never view-only params", () => {
    const q = new URLSearchParams(
      searchApiQuery(new URLSearchParams("popularService=haircut&priceMax=500&layout=map&tab=recent&minLat=28.5&maxLat=28.8&minLng=77.2&maxLng=77.6")),
    );
    expect(q.get("popularService")).toBe("haircut");
    expect(q.get("priceMax")).toBe("500");
    expect(q.get("minLat")).toBe("28.5");
    expect(q.get("layout")).toBeNull();
    expect(q.get("tab")).toBeNull();
  });

  it("validates bounds on the shared schema", () => {
    expect(salonSearchQuerySchema.safeParse({ minLat: "28.5", maxLat: "28.8", minLng: "77.2", maxLng: "77.6" }).success).toBe(true);
    expect(salonSearchQuerySchema.safeParse({ minLat: "29", maxLat: "28" }).success).toBe(false);
  });
});

describe("feature flags", () => {
  it("keeps gift cards off unless explicitly enabled", () => {
    expect(giftCardsEnabled(undefined)).toBe(false);
    expect(giftCardsEnabled("1")).toBe(false);
    expect(giftCardsEnabled("true")).toBe(true);
  });
});
