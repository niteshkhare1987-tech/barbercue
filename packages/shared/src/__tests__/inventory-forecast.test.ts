import {
  DEFAULT_FORECAST_SETTINGS,
  analyticsCsv,
  estimateBatches,
  expiryRisks,
  forecastProduct,
  roundOrderQuantity,
  type ForecastInput,
} from "../inventory-forecast";

const days = (n: number, value: number) => Array.from({ length: n }, () => value);
const base = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  dailyUse: days(56, 25),
  historyDays: 120,
  stockOnHand: 500,
  bookedDemand14Days: 0,
  reorderThreshold: 0,
  minimumOrderQuantity: null,
  settings: DEFAULT_FORECAST_SETTINGS,
  today: "2026-11-02",
  ...over,
});

describe("forecastProduct", () => {
  it("the brief's example: 500 ml at 25 ml a day, 5-day delivery, 3-day cushion", () => {
    const f = forecastProduct(base());
    expect(f).toMatchObject({ confidence: "HIGH", dailyRate: 25, daysLeft: 20, stockOutDate: "2026-11-22", trend: "STEADY", status: "OK" });
    // Reorder when 8 days of stock (200 ml) are left: in 12 days.
    expect(f.reorderPoint).toBe(200);
    expect(f.reorderDate).toBe("2026-11-14");
  });

  it("says when to order and how much, rounded up to the minimum order", () => {
    const soon = forecastProduct(base({ stockOnHand: 300 }));
    expect(soon).toMatchObject({ status: "ORDER_SOON", reorderDate: "2026-11-06" });
    const now = forecastProduct(base({ stockOnHand: 150, minimumOrderQuantity: 100 }));
    expect(now.status).toBe("ORDER_NOW");
    // 25 × (5 + 14 + 3) − 150 = 400 → already a multiple of 100.
    expect(now.suggestedOrderQuantity).toBe(400);
    expect(forecastProduct(base({ stockOnHand: 160, minimumOrderQuantity: 100 })).suggestedOrderQuantity).toBe(400);
    expect(roundOrderQuantity(390.2, null)).toBe(391);
    expect(roundOrderQuantity(0, 6)).toBe(0);
  });

  it("weighs recent use more and reports the trend", () => {
    const rising = forecastProduct(base({ dailyUse: [...days(42, 10), ...days(14, 30)] }));
    expect(rising.trend).toBe("UP");
    // 0.6 × 30 + 0.4 × 15 = 24
    expect(rising.dailyRate).toBe(24);
    expect(forecastProduct(base({ dailyUse: [...days(42, 30), ...days(14, 10)] })).trend).toBe("DOWN");
  });

  it("does not invent a prediction without enough history", () => {
    const f = forecastProduct(base({ dailyUse: days(4, 25), historyDays: 4 }));
    expect(f).toMatchObject({ confidence: "NOT_ENOUGH_DATA", status: "NO_DATA", dailyRate: null, stockOutDate: null, reorderDate: null });
    expect(f.explanation).toMatch(/Not enough data/);
    // ...but still flags stock at or below the owner's warning level.
    expect(forecastProduct(base({ dailyUse: [], historyDays: 2, stockOnHand: 3, reorderThreshold: 5 }))).toMatchObject({ status: "ORDER_NOW", reorderDate: "2026-11-02" });
  });

  it("uses upcoming bookings when they need more than recent use", () => {
    const f = forecastProduct(base({ dailyUse: days(56, 5), bookedDemand14Days: 280 }));
    expect(f.dailyRate).toBe(20);
    expect(f.explanation).toMatch(/Upcoming bookings/);
    // Bookings alone give a low-confidence estimate rather than nothing.
    expect(forecastProduct(base({ dailyUse: [], historyDays: 1, bookedDemand14Days: 140 }))).toMatchObject({ confidence: "LOW", dailyRate: 10 });
  });

  it("out of stock is always order now", () => {
    expect(forecastProduct(base({ stockOnHand: 0 }))).toMatchObject({ status: "OUT_OF_STOCK", daysLeft: 0, stockOutDate: "2026-11-02" });
  });
});

describe("batches and expiry (oldest used first)", () => {
  const receipts = [
    { quantity: 10, batchNumber: "A", expiryDate: "2026-11-10", receivedAt: "2026-09-01T00:00:00Z" },
    { quantity: 10, batchNumber: "B", expiryDate: "2027-03-01", receivedAt: "2026-10-01T00:00:00Z" },
  ];

  it("the stock on hand comes from the newest receipts", () => {
    expect(estimateBatches(14, receipts).map((b) => [b.batchNumber, b.remaining])).toEqual([["A", 4], ["B", 10]]);
    expect(estimateBatches(6, receipts).map((b) => b.batchNumber)).toEqual(["B"]);
    expect(estimateBatches(0, receipts)).toEqual([]);
  });

  it("estimates how much of an expiring batch won't be used in time", () => {
    const batches = estimateBatches(14, receipts);
    // 8 days to expiry at 0.25 a day = 2 used; 4 left → 2 at risk. Batch B is outside 30 days.
    expect(expiryRisks(batches, 0.25, "2026-11-02")).toEqual([expect.objectContaining({ batchNumber: "A", daysToExpiry: 8, atRisk: 2 })]);
    expect(expiryRisks(batches, 1, "2026-11-02")[0].atRisk).toBe(0);
    expect(expiryRisks(batches, 1, "2026-11-12")[0]).toMatchObject({ daysToExpiry: -2, atRisk: 4 });
  });
});

describe("analytics CSV", () => {
  it("quotes commas and neutralises formula-like text", () => {
    const csv = analyticsCsv({
      range: { from: "2026-10-01", to: "2026-10-31" }, currency: "INR",
      totals: { receivedValue: "0", usedValue: "0", lostValue: "0", stockValue: "0" }, byWeek: [], byCategory: [],
      products: [{ productId: "p", name: "=HYPERLINK(1)", categoryName: "Gel, wax", unit: "EACH", receivedQuantity: "1", receivedValue: "2", usedQuantity: "1", usedValue: "2", lostQuantity: "0", lostValue: "0", stockOnHand: "0", stockValue: "0" }],
    });
    expect(csv.split("\r\n")[1]).toBe(`'=HYPERLINK(1),"Gel, wax",EACH,1,2,1,2,0,0,0,0`);
  });
});
