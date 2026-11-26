import { SETTLEMENT_COLUMNS, applyPromotions, commerceBannerSchema, forecastDemand, mapColumns, parseSheetDate, parseSheetMoney, splitPaise, type PromotionRule } from "../commerce-extras";

const rule = (o: Partial<PromotionRule>): PromotionRule => ({ id: "p", name: "P", kind: "PERCENT", listingIds: ["a"], buyQty: 1, getQty: 0, value: "10", pinRules: [], startsAt: null, endsAt: null, isActive: true, ...o });
const now = new Date("2026-11-25T00:00:00Z");
const line = (listingId: string, quantity: number, unitPaise: number) => ({ listingId, quantity, unitPaise });

describe("automatic offers", () => {
  it("gives free units only for complete sets", () => {
    const p = rule({ kind: "BUY_X_GET_Y", buyQty: 2, getQty: 1 });
    expect(applyPromotions([p], [line("a", 2, 100)], undefined, now)).toEqual([]);
    expect(applyPromotions([p], [line("a", 7, 100)], undefined, now)[0].amountPaise).toBe(200);
  });
  it("splits a bundle saving exactly and only when every product is there", () => {
    const p = rule({ kind: "BUNDLE", listingIds: ["a", "b"], value: "1.00" });
    expect(applyPromotions([p], [line("a", 1, 70)], undefined, now)).toEqual([]);
    const r = applyPromotions([p], [line("a", 2, 70), line("b", 1, 64)], undefined, now)[0];
    expect(r.amountPaise).toBe(34);
    expect(r.perListing.a + r.perListing.b).toBe(34);
    expect(splitPaise(10, [1, 1, 1])).toEqual([3, 3, 4]);
  });
  it("never stacks two offers on one product, and picks the better", () => {
    const r = applyPromotions([rule({ id: "x" }), rule({ id: "y", value: "20" })], [line("a", 1, 1000)], undefined, now);
    expect(r.map((x) => [x.id, x.amountPaise])).toEqual([["y", 200]]);
  });
  it("respects area, dates and the switch", () => {
    const go = (o: Partial<PromotionRule>, pin?: string) => applyPromotions([rule(o)], [line("a", 1, 1000)], pin, now).length;
    expect([go({ pinRules: ["2013"] }), go({ pinRules: ["2013"] }, "560001"), go({ pinRules: ["2013"] }, "201310")]).toEqual([0, 0, 1]);
    expect(go({ startsAt: new Date("2026-12-01") }) + go({ endsAt: now }) + go({ isActive: false })).toBe(0);
  });
});

describe("demand forecast", () => {
  it("says nothing without enough history", () => {
    expect(forecastDemand([0, 0, 0, 0, 0, 0, 0, 9])).toBeNull();
    expect(forecastDemand([0, 0, 0, 0])).toBeNull();
    expect(forecastDemand([])).toBeNull();
  });
  it("weights recent weeks more and never goes below zero", () => {
    const f = forecastDemand([1, 1, 1, 9])!;
    expect(f.weeklyAverage).toBeGreaterThan(3);
    expect(f.low).toBeGreaterThanOrEqual(0);
    expect(f.basis).toContain("1, 1, 1, 9");
  });
});

describe("spreadsheet parsing", () => {
  it("maps headings in any order and style", () => {
    expect(mapColumns(["UTR", "AWB No.", "COD Amount"], SETTLEMENT_COLUMNS)).toEqual({ match: 1, amount: 2, reference: 0 });
  });
  it("reads Indian, ISO and Excel dates and refuses impossible ones", () => {
    expect(parseSheetDate("31/12/2028")).toBe("2028-12-31");
    expect(parseSheetDate("2028-12-31")).toBe("2028-12-31");
    expect(parseSheetDate("47118")).toBe("2028-12-31");
    expect(parseSheetDate("31/02/2028")).toBeNull();
    expect(parseSheetDate("soon")).toBeNull();
  });
  it("reads money and refuses anything else", () => {
    expect(parseSheetMoney("₹1,234.5")).toBe("1234.50");
    expect(parseSheetMoney("Rs. 20")).toBe("20.00");
    expect(parseSheetMoney("-5")).toBeNull();
    expect(parseSheetMoney("12abc")).toBeNull();
  });
});

describe("banner links", () => {
  it("stay inside the shop", () => {
    const ok = (linkPath: string) => commerceBannerSchema.safeParse({ title: "Hi", linkPath }).success;
    expect([ok("/shop"), ok("/shop/fastque?category=Hair+Care"), ok("//evil.com"), ok("https://evil.com"), ok("/shop/../admin"), ok("javascript:alert(1)")]).toEqual([true, true, false, false, false, false]);
  });
});
