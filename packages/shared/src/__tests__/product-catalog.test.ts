import {
  expandUpcE,
  gtinCheckDigit,
  normalizeBarcode,
  parseCsv,
  receiveCatalogStockSchema,
  submitCatalogProductSchema,
  validateCatalogCsv,
} from "../product-catalog";
import { createInventoryMovementSchema } from "../inventory";

describe("barcodes", () => {
  it("computes GS1 check digits", () => {
    expect(gtinCheckDigit("590123412345")).toBe(7); // EAN-13 5901234123457
    expect(gtinCheckDigit("9638507")).toBe(4); // EAN-8 96385074
    expect(gtinCheckDigit("03600029145")).toBe(2); // UPC-A 036000291452
  });

  it("stores retail barcodes as 14-digit text, keeping leading zeros", () => {
    expect(normalizeBarcode("5901234123457")).toEqual({ ok: true, code: "05901234123457", format: "GTIN", display: "5901234123457" });
    // UPC-A and the same code as EAN-13 (leading 0) are the same product.
    expect(normalizeBarcode("036000291452")).toMatchObject({ code: "00036000291452" });
    expect(normalizeBarcode("0036000291452")).toMatchObject({ code: "00036000291452" });
    expect(normalizeBarcode(" 5901-2341 23457 ")).toMatchObject({ ok: true, code: "05901234123457" });
    expect(normalizeBarcode("96385074")).toMatchObject({ ok: true, code: "00000096385074" });
  });

  it("rejects a wrong check digit, empty input and odd characters", () => {
    expect(normalizeBarcode("5901234123458")).toMatchObject({ ok: false });
    expect(normalizeBarcode("   ")).toMatchObject({ ok: false });
    expect(normalizeBarcode("ABC 123 ✓")).toMatchObject({ ok: false });
  });

  it("keeps other symbologies (Code 128) as uppercase text", () => {
    expect(normalizeBarcode("salon-sku-42")).toEqual({ ok: true, code: "SALONSKU42", format: "OTHER", display: "salonsku42" });
    expect(normalizeBarcode("12345")).toMatchObject({ ok: true, code: "12345", format: "OTHER" });
  });

  it("expands UPC-E when the scanner says so", () => {
    expect(expandUpcE("01234565")).toBe("012345000065");
    expect(normalizeBarcode("01234565", "UPC_E")).toMatchObject({ ok: true, code: "00012345000065" });
    expect(normalizeBarcode("91234565", "UPC_E")).toMatchObject({ ok: false });
  });
});

describe("catalog schemas", () => {
  it("validates a salon submission's barcode", () => {
    expect(submitCatalogProductSchema.safeParse({ barcode: "5901234123457", name: "Shave gel" }).success).toBe(true);
    expect(submitCatalogProductSchema.safeParse({ barcode: "5901234123458", name: "Shave gel" }).success).toBe(false);
  });

  it("receiving needs a positive quantity and a cost; dates are YYYY-MM-DD", () => {
    const base = { globalProductId: "11111111-1111-4111-8111-111111111111", quantity: 2, unitCost: 120 };
    expect(receiveCatalogStockSchema.parse(base).usage).toBe("PROFESSIONAL");
    expect(receiveCatalogStockSchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
    expect(receiveCatalogStockSchema.safeParse({ ...base, expiryDate: "30/06/2027" }).success).toBe(false);
  });

  it("write-offs lower stock without a cost; batch/expiry only on incoming stock; transfers use their own action", () => {
    expect(createInventoryMovementSchema.safeParse({ kind: "DAMAGE", quantity: 1 }).success).toBe(true);
    expect(createInventoryMovementSchema.safeParse({ kind: "DAMAGE", quantity: 1, unitCost: 5 }).success).toBe(false);
    expect(createInventoryMovementSchema.safeParse({ kind: "EXPIRY", quantity: 1, supplierId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(createInventoryMovementSchema.safeParse({ kind: "RETURN", quantity: 1, supplierId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(createInventoryMovementSchema.safeParse({ kind: "CONSUMPTION", quantity: 1, batchNumber: "B1" }).success).toBe(false);
    expect(createInventoryMovementSchema.safeParse({ kind: "PURCHASE", quantity: 1, unitCost: 10, batchNumber: "B1", expiryDate: "2027-01-31" }).success).toBe(true);
    expect(createInventoryMovementSchema.safeParse({ kind: "TRANSFER_IN", quantity: 1 }).success).toBe(false);
  });
});

describe("catalog CSV", () => {
  it("parses quoted fields, commas, doubled quotes and newlines", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n\n"multi\nline",z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("reports every row: new, repeated in the file, already in the catalog, invalid", () => {
    const csv = [
      "Barcode,Name,Brand,Pack Size,Pack Unit,MRP,Product Type",
      "5901234123457,Shave Gel,Gillette,200,ml,₹199,professional",
      "5901234123457,Shave Gel again,,,,,",
      "96385074,Hair Wax,,100,g,249,retail",
      "5901234123458,Bad check digit,,,,,",
      "036000291452,Odd unit,,10,bucket,,",
    ].join("\n");
    const { rows, headerErrors } = validateCatalogCsv(csv, new Set(["00000096385074"]));
    expect(headerErrors).toEqual([]);
    expect(rows.map((r) => r.status)).toEqual(["NEW", "DUPLICATE_IN_FILE", "EXISTS", "INVALID", "INVALID"]);
    expect(rows[0].product).toMatchObject({ barcode: "05901234123457", packSize: 200, packUnit: "MILLILITER", mrp: 199, productType: "PROFESSIONAL" });
    expect(rows[1].errors[0]).toBe("Same barcode as line 2.");
    expect(rows[4].errors).toContain('Unknown pack unit "bucket".');
  });

  it("refuses a file without the required columns or with unknown ones", () => {
    expect(validateCatalogCsv("name\nx", new Set()).headerErrors).toContain('Missing the "barcode" column.');
    expect(validateCatalogCsv("barcode,name,colour\n1,x,red", new Set()).headerErrors).toContain("Unknown columns: colour.");
  });
});
