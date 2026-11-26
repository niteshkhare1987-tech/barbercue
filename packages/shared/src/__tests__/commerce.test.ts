import {
  COMMERCE_TRANSITIONS,
  CommerceOrderStatus,
  allowedCommerceTransitions,
  canCommerceTransition,
  commerceCheckoutSchema,
  commerceListingSchema,
  couponDiscount,
  effectivePrice,
  matchZone,
  taxInside,
} from "../commerce";

describe("order state machine", () => {
  it("covers every status and never leaves a final one", () => {
    expect(Object.keys(COMMERCE_TRANSITIONS).sort()).toEqual(Object.keys(CommerceOrderStatus).sort());
    for (const s of ["DELIVERED", "CANCELLED", "RETURNED"] as const) expect(allowedCommerceTransitions(s, "STAFF")).toEqual([]);
  });
  it("lets customers cancel only before packing", () => {
    expect(["PLACED", "CONFIRMED", "PROCESSING"].every((s) => canCommerceTransition(s as "PLACED", "CANCELLED", "CUSTOMER"))).toBe(true);
    expect(canCommerceTransition("PACKED", "CANCELLED", "CUSTOMER")).toBe(false);
    expect(canCommerceTransition("PLACED", "DELIVERED", "STAFF")).toBe(false);
    expect(allowedCommerceTransitions("SHIPPED", "CUSTOMER")).toEqual([]);
  });
});

describe("delivery zones", () => {
  const z = (id: string, priority: number, pinRules: string[], blockedPins: string[] = [], isActive = true) => ({ id, priority, pinRules, blockedPins, isActive });
  it("prefers priority, then the most specific rule, and honours blocks", () => {
    const zones = [z("wide", 10, ["2"]), z("city", 10, ["2013"]), z("one", 10, ["201310"]), z("off", 1, ["2"], [], false)];
    expect(matchZone("201310", zones)?.id).toBe("one");
    expect(matchZone("201301", zones)?.id).toBe("city");
    expect(matchZone("221001", zones)?.id).toBe("wide");
    expect(matchZone("110001", zones)).toBeNull();
    expect(matchZone("201310", [z("b", 1, ["2013"], ["201310"])])).toBeNull();
    expect(matchZone("01310", zones)).toBeNull();
  });
});

describe("money", () => {
  it("takes tax out of inclusive prices", () => {
    expect(taxInside(150000, 18)).toBe(22881);
    expect(taxInside(10000, 0)).toBe(0);
  });
  it("applies a promotional price only inside its window and never above the price", () => {
    const base = { price: "500.00", promoPrice: "400.00", promoStartsAt: new Date("2026-01-01"), promoEndsAt: new Date("2026-02-01") };
    expect(effectivePrice(base, new Date("2025-12-31"))).toBe("500.00");
    expect(effectivePrice(base, new Date("2026-01-15"))).toBe("400.00");
    expect(effectivePrice(base, new Date("2026-02-01"))).toBe("500.00");
    expect(effectivePrice({ ...base, promoPrice: null }, new Date("2026-01-15"))).toBe("500.00");
  });
  it("caps coupons at their limit and at the goods", () => {
    const c = (kind: string, value: string, maxDiscount: string | null = null) => ({ kind, value, maxDiscount, minOrder: "0" });
    expect(couponDiscount(c("PERCENT", "20", "60"), 50000, 4000)).toBe(6000);
    expect(couponDiscount(c("FIXED", "900"), 50000, 4000)).toBe(50000);
    expect(couponDiscount(c("FREE_DELIVERY", "0"), 50000, 4000)).toBe(4000);
  });
});

describe("request schemas", () => {
  it("refuses an empty bag and unknown fields such as a client price", () => {
    const base = { contactName: "Asha", contactPhone: "9876543210" };
    expect(commerceCheckoutSchema.safeParse(base).success).toBe(false);
    expect(commerceCheckoutSchema.safeParse({ ...base, total: "1" }).success).toBe(false);
  });
  it("never allows a price above MRP", () => {
    const l = { globalProductId: "p", sku: "SKU1", mrp: "100", price: "120" };
    expect(commerceListingSchema.safeParse(l).success).toBe(false);
    expect(commerceListingSchema.safeParse({ ...l, price: "90", promoPrice: "95" }).success).toBe(false);
    expect(commerceListingSchema.safeParse({ ...l, price: "90" }).success).toBe(true);
  });
});
