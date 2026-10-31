// Pure logic only (PR #249 contract). The server owns every balance and cost; this only checks entry and words results.
import * as I from "../inventory";

const product = (over = {}) => ({
  id: "p1", salonId: "s1", name: "Shampoo", sku: "SH-1", unit: "LITER", stockOnHand: "12.500", averageUnitCost: "80.00", reorderThreshold: "5.000",
  isLowStock: false, isActive: true, category: { id: "c1", name: "Hair" }, supplier: { id: "s9", name: "Acme" }, updatedAt: "2026-10-17T00:00:00.000Z", ...over,
});

describe("showing server numbers", () => {
  it("trims trailing zeros of a server decimal and leaves anything else alone", () => {
    expect(I.trimDecimal("12.500")).toBe("12.5");
    expect(I.trimDecimal("12.000")).toBe("12");
    expect(I.trimDecimal("0.001")).toBe("0.001");
    expect(I.trimDecimal("100")).toBe("100");
    expect(I.trimDecimal("-3.250")).toBe("-3.25");
    expect(I.trimDecimal("abc")).toBe("abc");
  });
  it("writes quantities with their unit", () => {
    expect(I.quantityText("12.500", "KILOGRAM")).toBe("12.5 kg");
    expect(I.quantityText("3.000", "EACH")).toBe("3 pcs");
    expect(I.quantityText("1.000", "WEIRD")).toBe("1 WEIRD");
  });
  it("signs a recorded change as the server recorded it", () => {
    expect(I.signedQuantity("3.000")).toBe("+3");
    expect(I.signedQuantity("-2.500")).toBe("-2.5");
  });
  it("shows money in the shop's currency and invents no symbol when it is unknown", () => {
    expect(I.moneyText("360.00", "INR")).toBe("₹360");
    expect(I.moneyText("1234567.50", "INR")).toBe("₹12,34,567.50");
    expect(I.moneyText("99.5", "USD")).toBe("USD 99.50");
    expect(I.moneyText("360.00", null)).toBe("360");
    expect(I.moneyText("-12.40", "INR")).toBe("-₹12.40");
    expect(I.moneyText(null, "INR")).toBe("—");
    expect(I.moneyText("abc", "INR")).toBe("—");
  });
});

describe("reading what the owner typed", () => {
  it("accepts a positive quantity of at most three decimals", () => {
    expect(I.parseQuantity("2")).toEqual({ value: 2 });
    expect(I.parseQuantity("1,5")).toEqual({ value: 1.5 });
    expect(I.parseQuantity(" 0.001 ")).toEqual({ value: 0.001 });
  });
  it("refuses empty, zero, negative, too many decimals, text and huge quantities", () => {
    for (const bad of ["", "0", "0.000", "-1", "1.2345", "abc", "1e3", "1000000000"]) expect("error" in I.parseQuantity(bad)).toBe(true);
  });
  it("allows a warning level of zero or empty", () => {
    expect(I.parseThreshold("")).toEqual({ value: 0 });
    expect(I.parseThreshold("0")).toEqual({ value: 0 });
    expect(I.parseThreshold("2.5")).toEqual({ value: 2.5 });
    expect("error" in I.parseThreshold("-1")).toBe(true);
  });
  it("accepts a cost with at most two decimals", () => {
    expect(I.parseMoney("99.50")).toEqual({ value: 99.5 });
    expect(I.parseMoney("0")).toEqual({ value: 0 });
    for (const bad of ["", "1.234", "-5", "abc"]) expect("error" in I.parseMoney(bad)).toBe(true);
  });
});

describe("buildMovement (the server's own rules, checked first)", () => {
  const form = (over = {}) => ({ ...I.EMPTY_MOVEMENT, ...over });
  it("a purchase needs a quantity and a unit cost, and may carry a supplier and a reference", () => {
    expect(I.buildMovement("PURCHASE", form({ quantity: "5", unitCost: "80", supplierId: "s1", reference: "INV-9" })).body).toEqual({ kind: "PURCHASE", quantity: 5, unitCost: 80, supplierId: "s1", reference: "INV-9" });
    const missing = I.buildMovement("PURCHASE", form({ quantity: "5" }));
    expect(missing.body).toBeNull();
    expect(missing.errors.unitCost).toBeTruthy();
  });
  it("opening stock needs a cost and never a supplier", () => {
    expect(I.buildMovement("OPENING", form({ quantity: "10", unitCost: "50", supplierId: "s1" })).body).toEqual({ kind: "OPENING", quantity: 10, unitCost: 50 });
  });
  it("stock used sends no cost, supplier or direction", () => {
    expect(I.buildMovement("CONSUMPTION", form({ quantity: "2", unitCost: "9", supplierId: "s1", direction: "INCREASE" })).body).toEqual({ kind: "CONSUMPTION", quantity: 2 });
  });
  it("an adjustment needs a direction and a reason", () => {
    const none = I.buildMovement("ADJUSTMENT", form({ quantity: "1" }));
    expect(none.body).toBeNull();
    expect(none.errors.direction).toBeTruthy();
    expect(none.errors.reason).toBeTruthy();
    expect(I.buildMovement("ADJUSTMENT", form({ quantity: "1", direction: "DECREASE", reason: " expired " })).body).toEqual({ kind: "ADJUSTMENT", quantity: 1, adjustmentDirection: "DECREASE", reason: "expired" });
  });
  it("reports every problem at once and sends nothing", () => {
    const r = I.buildMovement("ADJUSTMENT", form({ quantity: "0" }));
    expect(r.body).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual(["direction", "quantity", "reason"]);
  });
  it("limits the note and the reference like the server", () => {
    expect(I.buildMovement("CONSUMPTION", form({ quantity: "1", reason: "x".repeat(301) })).errors.reason).toContain("300");
    expect(I.buildMovement("CONSUMPTION", form({ quantity: "1", reference: "x".repeat(121) })).errors.reference).toContain("120");
  });
});

describe("attempt keys and summaries", () => {
  it("makes a key of the shape the server accepts (8 to 128 safe characters)", () => {
    const key = I.newMovementKey();
    expect(key).toMatch(/^inv-[0-9a-f-]{36}$/);
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(I.newMovementKey(() => "abc")).toBe("inv-abc");
  });
  it("restates what was typed and never predicts a balance", () => {
    const p = product();
    expect(I.movementSummary("PURCHASE", p, { kind: "PURCHASE", quantity: 5, unitCost: 80 })).toBe("Add 5 L of Shampoo bought at 80 per L.");
    expect(I.movementSummary("CONSUMPTION", p, { kind: "CONSUMPTION", quantity: 2.5 })).toBe("Take 2.5 L of Shampoo out of stock as used.");
    expect(I.movementSummary("ADJUSTMENT", p, { kind: "ADJUSTMENT", quantity: 1, adjustmentDirection: "DECREASE", reason: "expired" })).toBe("Reduce Shampoo by 1 L. Reason: expired.");
    expect(I.movementSummary("OPENING", p, { kind: "OPENING", quantity: 10, unitCost: 50 })).toContain("once per product");
  });
  it("words the server's refusals plainly and keeps an unknown message", () => {
    expect(I.movementErrorText("INVENTORY_INSUFFICIENT_STOCK", "x")).toContain("not enough stock");
    expect(I.movementErrorText("INVENTORY_OPENING_ALREADY_RECORDED", "x")).toContain("already recorded");
    expect(I.movementErrorText("INVENTORY_IDEMPOTENCY_KEY_REUSED", "x")).toContain("different entry");
    expect(I.movementErrorText("SOMETHING_NEW", "Server said this")).toBe("Server said this");
  });
});

describe("product forms", () => {
  it("builds a create body with only what was filled in", () => {
    expect(I.buildCreateProduct({ ...I.EMPTY_PRODUCT, name: " Shampoo ", unit: "LITER", reorderThreshold: "5" }).body).toEqual({ name: "Shampoo", unit: "LITER", reorderThreshold: 5, isActive: true });
    expect(I.buildCreateProduct({ ...I.EMPTY_PRODUCT, name: "Gel", sku: "G1", categoryId: "c1", supplierId: "s1" }).body).toMatchObject({ sku: "G1", categoryId: "c1", supplierId: "s1", reorderThreshold: 0 });
  });
  it("asks for a name and a valid warning level", () => {
    const r = I.buildCreateProduct({ ...I.EMPTY_PRODUCT, name: " ", reorderThreshold: "-2" });
    expect(r.body).toBeNull();
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.reorderThreshold).toBeTruthy();
  });
  it("never lets a product be created with a stock figure", () => {
    expect(Object.keys(I.buildCreateProduct({ ...I.EMPTY_PRODUCT, name: "Gel" }).body)).not.toContain("stockOnHand");
  });
  it("sends only the fields that changed, and nothing when nothing changed", () => {
    const p = product();
    expect(I.buildProductPatch(p, I.productFormFrom(p))).toMatchObject({ body: null, changed: false });
    expect(I.buildProductPatch(p, { ...I.productFormFrom(p), name: "Shampoo XL", reorderThreshold: "8" }).body).toEqual({ name: "Shampoo XL", reorderThreshold: 8 });
    expect(I.buildProductPatch(p, { ...I.productFormFrom(p), categoryId: "", sku: "", isActive: false }).body).toEqual({ categoryId: null, sku: null, isActive: false });
  });
  it("never sends the unit on an edit", () => {
    const p = product();
    expect(I.buildProductPatch(p, { ...I.productFormFrom(p), unit: "GRAM", name: "New" }).body).toEqual({ name: "New" });
  });
});

describe("supplier and category forms", () => {
  it("builds a supplier body and validates the email", () => {
    expect(I.buildSupplier({ ...I.EMPTY_SUPPLIER, name: " Acme ", email: "a@b.co" }).body).toEqual({ name: "Acme", email: "a@b.co" });
    expect(I.buildSupplier({ ...I.EMPTY_SUPPLIER, name: "Acme", email: "nope" }).errors.email).toBeTruthy();
    expect(I.buildSupplier(I.EMPTY_SUPPLIER).errors.name).toBeTruthy();
  });
  it("validates a category name", () => {
    expect(I.validateCategoryName("Hair")).toBeNull();
    expect(I.validateCategoryName(" ")).toBeTruthy();
    expect(I.validateCategoryName("x".repeat(81))).toContain("80");
  });
  it("words duplicate and missing-reference refusals", () => {
    expect(I.entityErrorText("INVENTORY_CATEGORY_EXISTS", "x")).toContain("already have a category");
    expect(I.entityErrorText("INVENTORY_PRODUCT_EXISTS", "x")).toContain("product");
    expect(I.entityErrorText("OTHER", "msg")).toBe("msg");
  });
});

describe("list queries", () => {
  it("leaves out empty filters, adds the cursor and the limit", () => {
    expect(I.listQuery({ q: "", lowStock: false, categoryId: null }, null)).toBe("limit=25");
    expect(I.listQuery({ q: "gel", lowStock: "true" }, "CUR", 10)).toBe("limit=10&q=gel&lowStock=true&cursor=CUR");
  });
  it("does not search for one character and caps the search text", () => {
    expect(I.searchTerm("a")).toBe("");
    expect(I.searchTerm(" gel ")).toBe("gel");
    expect(I.searchTerm("x".repeat(200))).toHaveLength(120);
  });
});

describe("labels", () => {
  it("names every movement type and shows an unknown one as sent", () => {
    expect(I.kindLabel("CONSUMPTION")).toBe("Used");
    expect(I.kindLabel("OPENING")).toBe("Opening stock");
    expect(I.kindLabel("DAMAGE")).toBe("Damaged");
    expect(I.kindLabel("TRANSFER_IN")).toBe("Moved from other shelf");
    expect(I.kindLabel("NEW")).toBe("NEW");
    expect(I.MOVEMENT_KINDS).toHaveLength(10);
    expect(I.MOVEMENT_KINDS.every((k) => I.KIND_LABEL[k])).toBe(true);
  });
  it("offers the eight units the server accepts", () => {
    expect(I.UNIT_OPTIONS.map((u) => u.value).sort()).toEqual(["BOX", "EACH", "GRAM", "KILOGRAM", "LITER", "MILLILITER", "OTHER", "PACK"]);
    expect(I.isUnit("LITER")).toBe(true);
    expect(I.isUnit("YARD")).toBe(false);
  });
  it("tones a movement by direction", () => {
    expect(I.movementTone("CONSUMPTION", "-2.000")).toBe("warn");
    expect(I.movementTone("PURCHASE", "5.000")).toBe("ok");
    expect(I.movementTone("ADJUSTMENT", "-1.000")).toBe("warn");
    expect(I.movementTone("ADJUSTMENT", "1.000")).toBe("neutral");
  });
});
