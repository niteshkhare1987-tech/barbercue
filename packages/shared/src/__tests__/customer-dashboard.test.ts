import {
  customerBookingListQuerySchema,
  customerInvoiceListQuerySchema,
  dayRangeBounds,
  greetingForHour,
  presetRange,
  straightLineKm,
} from "../customer-dashboard";

describe("customer dashboard shared helpers", () => {
  it("turns inclusive calendar days into [start, nextDayStart)", () => {
    expect(dayRangeBounds("2026-11-01", "2026-11-07")).toEqual({
      gte: new Date("2026-11-01T00:00:00.000Z"),
      lt: new Date("2026-11-08T00:00:00.000Z"),
    });
    expect(dayRangeBounds()).toEqual({});
  });

  it("builds date presets ending today", () => {
    const now = new Date(2026, 10, 13, 15, 0);
    expect(presetRange("today", now)).toEqual({ from: "2026-11-13", to: "2026-11-13" });
    expect(presetRange("7d", now)).toEqual({ from: "2026-11-07", to: "2026-11-13" });
    expect(presetRange("12m", now).from).toBe("2025-11-13");
  });

  it("greets by local hour", () => {
    expect(greetingForHour(8)).toBe("Good morning");
    expect(greetingForHour(13)).toBe("Good afternoon");
    expect(greetingForHour(22)).toBe("Good evening");
    expect(greetingForHour(3)).toBe("Good evening");
  });

  it("computes straight-line distance", () => {
    // Delhi (Connaught Place) → Noida Sector 18 ≈ 15 km in a straight line.
    const km = straightLineKm({ lat: 28.6315, lng: 77.2167 }, { lat: 28.5708, lng: 77.3261 });
    expect(km).toBeGreaterThan(12);
    expect(km).toBeLessThan(14);
  });

  it("validates booking list filters", () => {
    const ok = customerBookingListQuerySchema.parse({ status: "COMPLETED,CANCELLED", from: "2026-11-01", to: "2026-11-30", sort: "oldest" });
    expect(ok.status).toEqual(["COMPLETED", "CANCELLED"]);
    expect(customerBookingListQuerySchema.safeParse({ status: "HACKED" }).success).toBe(false);
    expect(customerBookingListQuerySchema.safeParse({ from: "2026-02-31" }).success).toBe(false);
    expect(customerBookingListQuerySchema.safeParse({ from: "2026-11-30", to: "2026-11-01" }).success).toBe(false);
    expect(customerBookingListQuerySchema.parse({})).toEqual({});
  });

  it("validates invoice list filters", () => {
    expect(customerInvoiceListQuerySchema.safeParse({ q: "INV-1", paymentStatus: "PAID" }).success).toBe(true);
    expect(customerInvoiceListQuerySchema.safeParse({ salonId: "not-a-uuid" }).success).toBe(false);
  });
});
