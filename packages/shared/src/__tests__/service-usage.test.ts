import {
  convertToStockUnit,
  putServiceRecipeSchema,
  recordServiceUsageSchema,
  suggestCategoriesForService,
} from "../service-usage";

describe("unit conversion for service usage", () => {
  it("converts within the same kind of unit", () => {
    expect(convertToStockUnit(250, "MILLILITER", { unit: "LITER" })).toEqual({ ok: true, quantity: 0.25 });
    expect(convertToStockUnit(1.5, "KILOGRAM", { unit: "GRAM" })).toEqual({ ok: true, quantity: 1500 });
    expect(convertToStockUnit(2, "EACH", { unit: "EACH" })).toEqual({ ok: true, quantity: 2 });
  });

  it("takes ml/g off stock counted in pieces through 'one piece contains'", () => {
    const tube = { unit: "EACH" as const, contentSize: "200.000", contentUnit: "MILLILITER" as const };
    expect(convertToStockUnit(10, "MILLILITER", tube)).toEqual({ ok: true, quantity: 0.05 });
    expect(convertToStockUnit(0.1, "LITER", tube)).toEqual({ ok: true, quantity: 0.5 });
    // 10 ml of a 195 ml bottle: rounded to the ledger's 3 decimals.
    expect(convertToStockUnit(10, "MILLILITER", { ...tube, contentSize: 195 })).toEqual({ ok: true, quantity: 0.051 });
    // Never rounds a real amount down to nothing.
    expect(convertToStockUnit(0.1, "MILLILITER", { ...tube, contentSize: 1000 })).toEqual({ ok: true, quantity: 0.001 });
  });

  it("refuses what can't be converted, with a reason", () => {
    expect(convertToStockUnit(5, "MILLILITER", { unit: "EACH" })).toMatchObject({ ok: false, reason: expect.stringMatching(/one piece contains/) });
    expect(convertToStockUnit(5, "GRAM", { unit: "EACH", contentSize: 200, contentUnit: "MILLILITER" })).toMatchObject({ ok: false });
    expect(convertToStockUnit(0, "EACH", { unit: "EACH" })).toMatchObject({ ok: false });
  });
});

describe("rule-based service suggestions (no AI)", () => {
  it("suggests product categories from the service name or category", () => {
    expect(suggestCategoriesForService({ name: "Classic Shave" })).toEqual(["Shaving cream", "Blades", "Aftershave"]);
    expect(suggestCategoriesForService({ name: "Global", category: "Hair Color" })).toEqual(["Hair colour", "Developer", "Colour treatment"]);
    expect(suggestCategoriesForService({ name: "Hair spa with wash" })).toEqual(["Hair mask", "Conditioner", "Serum", "Shampoo"]);
    expect(suggestCategoriesForService({ name: "Consultation" })).toEqual([]);
  });
});

describe("schemas", () => {
  const cat = "11111111-1111-4111-8111-111111111111";
  const prod = "22222222-2222-4222-8222-222222222222";
  it("automatic deduction needs a default product; a category appears once per service", () => {
    expect(putServiceRecipeSchema.safeParse({ lines: [{ inventoryCategoryId: cat, quantity: 10, unit: "MILLILITER", autoDeduct: true }] }).success).toBe(false);
    expect(putServiceRecipeSchema.safeParse({ lines: [{ inventoryCategoryId: cat, quantity: 10, unit: "MILLILITER", defaultProductId: prod, autoDeduct: true }] }).success).toBe(true);
    const line = { inventoryCategoryId: cat, quantity: 1, unit: "EACH" };
    expect(putServiceRecipeSchema.safeParse({ lines: [line, line] }).success).toBe(false);
  });

  it("each product once per service; amounts above zero", () => {
    const item = { productId: prod, quantity: 1, unit: "EACH" };
    expect(recordServiceUsageSchema.safeParse({ services: [{ serviceId: cat, items: [item] }] }).success).toBe(true);
    expect(recordServiceUsageSchema.safeParse({ services: [{ serviceId: cat, items: [item, item] }] }).success).toBe(false);
    expect(recordServiceUsageSchema.safeParse({ services: [{ serviceId: cat, items: [{ ...item, quantity: 0 }] }] }).success).toBe(false);
  });
});
