import React, { act } from "react";
import TestRenderer from "react-test-renderer";
import { ProductsView } from "../ProductsView";
import { CategoriesView, SuppliersView } from "../LookupViews";
import { HistoryView, LowStockView, MovementWorkspace, OverviewView, ReportView } from "../StockViews";
import { InventoryTabs, INVENTORY_SECTIONS } from "../shared";
import { apiFetch, ApiError } from "../../../../lib/api";

let mockPath = "/dashboard/salons/s1/inventory/products";
jest.mock("next/link", () => ({ __esModule: true, default: ({ children, href, ...rest }) => <a href={href} {...rest}>{children}</a> }));
jest.mock("next/navigation", () => ({ usePathname: () => mockPath }));
jest.mock("../../parts", () => ({ ...jest.requireActual("../../parts"), Dialog: ({ title, children }) => <div role="dialog" aria-label={title}>{children}</div> }));
jest.mock("../../../../lib/api", () => {
  class MockApiError extends Error {
    constructor(message, status = 400, code = "ERR") {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { apiFetch: jest.fn(), ApiError: MockApiError };
});

const collect = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collect).join(" ");
  return collect(node.children);
};
const text = (r) => collect(r.toJSON());
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const button = (r, label) => r.root.findAllByType("button").find((b) => new RegExp(label).test(collect(b.props.children)));
const dialogButton = (r, label) => r.root.findByProps({ role: "dialog" }).findAllByType("button").find((b) => new RegExp(label).test(collect(b.props.children)));
const labelled = (r, label) => r.root.findAllByType("button").find((b) => b.props["aria-label"] === label);
const type = async (r, id, value) => { await act(async () => { r.root.findByProps({ id }).props.onChange({ target: { value } }); }); };

const product = (over = {}) => ({
  id: "p1", salonId: "s1", name: "Shampoo", sku: "SH-1", unit: "LITER", stockOnHand: "4.500", averageUnitCost: "80.00", reorderThreshold: "5.000",
  isLowStock: true, isActive: true, category: { id: "c1", name: "Hair colour" }, supplier: { id: "u1", name: "Acme" }, updatedAt: "x", ...over,
});
const movement = (over = {}) => ({ id: "m1", salonId: "s1", productId: "p1", productName: "Shampoo", sku: "SH-1", kind: "CONSUMPTION", quantityDelta: "-8.000", unitCost: null, stockAfter: "4.500", averageUnitCostAfter: "80.00", supplier: null, actorUserId: "u", reason: "Used in colour", reference: null, recordedAt: "2026-10-17T10:00:00.000Z", ...over });
const report = (over = {}) => ({ productCount: 1, lowStockCount: 1, estimatedStockValue: "360.00", valuationBasis: "weighted-average-cost", currency: "INR", movementCounts: { OPENING: 1, PURCHASE: 0, CONSUMPTION: 1, ADJUSTMENT: 0 }, lowStockProducts: [product()], ...over });
const dashboard = (over = {}) => ({
  asOf: "2026-11-01", currency: "INR",
  totals: { activeProducts: 1, lowStock: 1, outOfStock: 0, stockValue: "360.00", expiringSoon: 0 },
  usageByDay: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 3).padStart(2, "0")}`, value: i === 29 ? "640.00" : "0.00", entries: i === 29 ? 1 : 0 })),
  usage: { today: "640.00", last7Days: "640.00", last30Days: "640.00" },
  purchases30Days: { value: "0.00", entries: 0 }, wastage30Days: { value: "0.00", entries: 0 }, retailOut30Days: { value: "0.00", entries: 0 },
  byService30Days: [{ serviceId: "sv1", serviceName: "Hair colour", visits: 2, value: "640.00" }],
  topProducts30Days: [], expiring: [], visitsMissingUsage7Days: 1, ...over,
});
const page = (items, nextCursor = null) => ({ items, nextCursor, hasMore: nextCursor !== null });

let calls;
let routes;
function install(overrides = {}) {
  calls = [];
  routes = {
    categories: () => page([{ id: "c1", salonId: "s1", name: "Hair colour", createdAt: "2026-10-01T00:00:00.000Z" }]),
    suppliers: () => page([{ id: "u1", salonId: "s1", name: "Acme", contactName: null, phone: null, email: null, notes: null, createdAt: "2026-10-01T00:00:00.000Z" }]),
    products: () => page([product()]),
    movements: () => page([movement()]),
    report: () => report(),
    dashboard: () => dashboard(),
    ...overrides,
  };
  apiFetch.mockImplementation(async (path, opts) => {
    calls.push({ path, opts });
    const segment = path.split("?")[0].replace("dashboard/salons/s1/inventory/", "").split("/")[0];
    const handler = routes[`${opts?.method ?? "GET"} ${path.split("?")[0].replace("dashboard/salons/s1/inventory/", "")}`] ?? routes[segment];
    if (!handler) throw new Error(`unexpected ${path}`);
    const result = handler(path, opts);
    if (result instanceof Error) throw result;
    return result;
  });
}
const params = (path) => new URLSearchParams(path.split("?")[1] ?? "");
const getCalls = (segment) => calls.filter((c) => !c.opts?.method && c.path.split("?")[0].endsWith(`/inventory/${segment}`));

async function mount(element) {
  let r;
  await act(async () => { r = TestRenderer.create(element); });
  await flush();
  await flush();
  return r;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
});

describe("InventoryTabs", () => {
  it("links every section (incl. Scan / Add stock) and marks the current one", async () => {
    mockPath = "/dashboard/salons/s1/inventory/low-stock";
    const r = await mount(<InventoryTabs salonId="s1" />);
    const links = r.root.findAll((n) => n.type === "a");
    expect(links).toHaveLength(14);
    expect(INVENTORY_SECTIONS).toHaveLength(14);
    expect(links.find((l) => l.props["aria-current"] === "page").props.href).toBe("/dashboard/salons/s1/inventory/low-stock");
    expect(links.filter((l) => l.props["aria-current"]).length).toBe(1);
  });
  it("marks Overview only on the inventory root", async () => {
    mockPath = "/dashboard/salons/s1/inventory";
    const r = await mount(<InventoryTabs salonId="s1" />);
    expect(r.root.findAll((n) => n.type === "a").find((l) => l.props["aria-current"] === "page").props.href).toBe("/dashboard/salons/s1/inventory");
  });
});

describe("ProductsView", () => {
  it("lists products with the server's stock, low flag and cost, never working them out", async () => {
    install();
    const r = await mount(<ProductsView salonId="s1" />);
    const t = text(r);
    expect(t).toContain("Shampoo");
    expect(t).toContain("4.5 L");
    expect(t).toContain("Low");
    expect(t).toContain("₹80 / L");
    expect(t).toContain("not a selling price and not revenue");
  });

  it("says plainly when there are no products and offers to add one", async () => {
    install({ products: () => page([]) });
    const r = await mount(<ProductsView salonId="s1" />);
    expect(text(r)).toContain("You have no products yet");
    expect(button(r, "Add your first product")).toBeTruthy();
  });

  it("shows the server's message when the list cannot be loaded, with a retry", async () => {
    install({ products: () => new ApiError("You do not have access to this shop.", 403, "FORBIDDEN") });
    const r = await mount(<ProductsView salonId="s1" />);
    expect(text(r)).toContain("You do not have access to this shop.");
    expect(button(r, "Try again")).toBeTruthy();
  });

  it("filters on the server by search, category and low stock, and drops the cursor", async () => {
    install();
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { r.root.findByProps({ id: "prod-search" }).props.onChange({ target: { value: "sham" } }); });
    await act(async () => { r.root.findByProps({ id: "prod-filter-category" }).props.onChange({ target: { value: "c1" } }); });
    await act(async () => { r.root.findByProps({ id: "prod-low" }).props.onChange({ target: { checked: true } }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); }); // the search waits for a pause in typing
    await flush();
    const last = params(getCalls("products").at(-1).path);
    expect(last.get("q")).toBe("sham");
    expect(last.get("categoryId")).toBe("c1");
    expect(last.get("lowStock")).toBe("true");
    expect(last.has("cursor")).toBe(false);
  });

  it("loads more with the cursor the server issued", async () => {
    install({ products: (path) => (params(path).get("cursor") ? page([product({ id: "p2", name: "Gel", sku: null })]) : page([product()], "CUR1")) });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { button(r, "Load more").props.onClick(); });
    await flush();
    expect(params(getCalls("products").at(-1).path).get("cursor")).toBe("CUR1");
    expect(text(r)).toContain("Gel");
    expect(text(r)).toContain("Shampoo");
  });

  it("restarts the list when the server says the cursor no longer matches the filters", async () => {
    let first = true;
    install({ products: (path) => {
      if (params(path).get("cursor")) return new ApiError("changed", 400, "CURSOR_FILTER_MISMATCH");
      if (first) { first = false; return page([product()], "CUR1"); }
      return page([product({ name: "Reloaded" })]);
    } });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { button(r, "Load more").props.onClick(); });
    await flush();
    await flush();
    expect(text(r)).toContain("reloaded from the start");
    expect(text(r)).toContain("Reloaded");
  });

  it("adds a product with no stock figure, then reloads the list", async () => {
    install({ "POST products": () => ({}) });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { button(r, "^\\s*Add product").props.onClick(); });
    await type(r, "prod-name", " Conditioner ");
    await type(r, "prod-unit", "MILLILITER");
    await type(r, "prod-threshold", "500");
    const before = getCalls("products").length;
    await act(async () => { dialogButton(r, "Add product").props.onClick(); });
    await flush();
    const post = calls.find((c) => c.opts?.method === "POST");
    expect(JSON.parse(post.opts.body)).toEqual({ name: "Conditioner", unit: "MILLILITER", reorderThreshold: 500, isActive: true });
    expect(getCalls("products").length).toBeGreaterThan(before);
    expect(text(r)).toContain("Product added.");
  });

  it("checks the form first and shows a duplicate refusal in plain words", async () => {
    install({ "POST products": () => new ApiError("dup", 409, "INVENTORY_PRODUCT_EXISTS") });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { button(r, "^\\s*Add product").props.onClick(); });
    await act(async () => { dialogButton(r, "Add product").props.onClick(); });
    expect(text(r)).toContain("Enter the product name");
    expect(calls.some((c) => c.opts?.method === "POST")).toBe(false);
    await type(r, "prod-name", "Shampoo");
    await act(async () => { dialogButton(r, "Add product").props.onClick(); });
    await flush();
    expect(text(r)).toContain("already have a product with this name or SKU");
  });

  it("edits only the changed fields and never offers to change the unit", async () => {
    install({ "PATCH products/p1": () => ({}) });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { labelled(r, "Edit Shampoo").props.onClick(); });
    expect(r.root.findByProps({ id: "prod-unit" }).props.disabled).toBe(true);
    await act(async () => { button(r, "Save changes").props.onClick(); });
    expect(text(r)).toContain("Nothing was changed");
    expect(calls.some((c) => c.opts?.method === "PATCH")).toBe(false);
    await type(r, "prod-threshold", "8");
    await act(async () => { button(r, "Save changes").props.onClick(); });
    await flush();
    expect(JSON.parse(calls.find((c) => c.opts?.method === "PATCH").opts.body)).toEqual({ reorderThreshold: 8 });
  });

  it("asks before stopping use of a product, says nothing is deleted, and then marks it not in use", async () => {
    install({ "PATCH products/p1": () => ({}) });
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { labelled(r, "Stop using Shampoo").props.onClick(); });
    expect(text(r)).toContain("nothing is deleted");
    expect(calls.some((c) => c.opts?.method === "PATCH")).toBe(false);
    await act(async () => { dialogButton(r, "Stop using").props.onClick(); });
    await flush();
    expect(JSON.parse(calls.find((c) => c.opts?.method === "PATCH").opts.body)).toEqual({ isActive: false });
    expect(text(r)).toContain("history is kept");
  });

  it("offers opening stock per product through the same safe movement flow", async () => {
    install();
    const r = await mount(<ProductsView salonId="s1" />);
    await act(async () => { labelled(r, "Record opening stock for Shampoo").props.onClick(); });
    expect(text(r)).toContain("Opening stock can be recorded once per product");
    expect(r.root.findByProps({ id: "qty-OPENING" })).toBeTruthy();
  });
});

describe("CategoriesView and SuppliersView", () => {
  it("adds a category and words a duplicate", async () => {
    install({ "POST categories": () => ({}) });
    const r = await mount(<CategoriesView salonId="s1" />);
    expect(text(r)).toContain("Hair colour");
    await type(r, "cat-name", "Skin care");
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(JSON.parse(calls.find((c) => c.opts?.method === "POST").opts.body)).toEqual({ name: "Skin care" });
    expect(text(r)).toContain("Skin care added.");
    routes["POST categories"] = () => new ApiError("dup", 409, "INVENTORY_CATEGORY_EXISTS");
    await type(r, "cat-name", "skin care");
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(text(r)).toContain("already have a category with this name");
  });

  it("refuses an empty category name before sending", async () => {
    install();
    const r = await mount(<CategoriesView salonId="s1" />);
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(text(r)).toContain("Enter a category name");
    expect(calls.some((c) => c.opts?.method === "POST")).toBe(false);
  });

  it("validates a supplier and sends only what was filled in", async () => {
    install({ "POST suppliers": () => ({}) });
    const r = await mount(<SuppliersView salonId="s1" />);
    await type(r, "sup-name", "Wholesale Co");
    await type(r, "sup-email", "nope");
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(text(r)).toContain("Enter a valid email address");
    expect(calls.some((c) => c.opts?.method === "POST")).toBe(false);
    await type(r, "sup-email", "orders@wholesale.test");
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await flush();
    expect(JSON.parse(calls.find((c) => c.opts?.method === "POST").opts.body)).toEqual({ name: "Wholesale Co", email: "orders@wholesale.test" });
    expect(text(r)).toContain("Nothing is sent to a supplier from here");
  });

  it("shows empty states", async () => {
    install({ categories: () => page([]), suppliers: () => page([]) });
    expect(text(await mount(<CategoriesView salonId="s1" />))).toContain("No categories yet");
    expect(text(await mount(<SuppliersView salonId="s1" />))).toContain("No suppliers yet");
  });
});

describe("stock views", () => {
  it("shows the stock history exactly as recorded, with server balances", async () => {
    install();
    const r = await mount(<HistoryView salonId="s1" />);
    const t = text(r);
    expect(t).toContain("Used");
    expect(t).toContain("-8");
    expect(t).toContain("4.5");
    expect(t).toContain("never edited or deleted");
  });

  it("filters history by type on the server", async () => {
    install();
    const r = await mount(<HistoryView salonId="s1" />);
    await act(async () => { r.root.findByProps({ id: "hist-kind" }).props.onChange({ target: { value: "PURCHASE" } }); });
    await flush();
    expect(params(getCalls("movements").at(-1).path).get("kind")).toBe("PURCHASE");
  });

  it("lists low-stock products from the server's own flag, with a way to restock", async () => {
    install();
    const r = await mount(<LowStockView salonId="s1" />);
    expect(params(getCalls("products").at(-1).path).get("lowStock")).toBe("true");
    expect(text(r)).toContain("Shampoo");
    expect(text(r)).toContain("Record a purchase");
  });

  it("says plainly when nothing is low", async () => {
    install({ products: () => page([]) });
    expect(text(await mount(<LowStockView salonId="s1" />))).toContain("Nothing is low on stock");
  });

  it("purchase, use and adjustment pages show only entries of their own type", async () => {
    install();
    for (const kind of ["PURCHASE", "CONSUMPTION", "ADJUSTMENT"]) {
      await mount(<MovementWorkspace salonId="s1" kind={kind} />);
      expect(params(getCalls("movements").at(-1).path).get("kind")).toBe(kind);
    }
  });

  it("labels the estimated stock value as an estimate at cost, never as revenue", async () => {
    install();
    const r = await mount(<ReportView salonId="s1" />);
    const t = text(r);
    expect(t).toContain("Estimated stock value (at cost)");
    expect(t).toContain("₹360");
    expect(t).toContain("not revenue, not money collected");
    expect(t).toContain("weighted average cost");
    expect(t).toMatch(/Opening stock\s+1/);
  });

  it("invents no currency symbol when the shop's currency is unknown", async () => {
    install({ report: () => report({ currency: null }) });
    const t = text(await mount(<ReportView salonId="s1" />));
    expect(t).toContain("360");
    expect(t).not.toContain("₹360");
    expect(t).toContain("currency not set");
  });

  it("shows the server's message when the report cannot be loaded", async () => {
    install({ report: () => new ApiError("You do not have access to this shop.", 403, "FORBIDDEN") });
    expect(text(await mount(<ReportView salonId="s1" />))).toContain("You do not have access to this shop.");
  });

  it("the overview guides a new shop to its first product and summarises a shop with stock", async () => {
    install({ report: () => report({ productCount: 0, lowStockCount: 0, estimatedStockValue: "0.00", lowStockProducts: [] }), movements: () => page([]) });
    expect(text(await mount(<OverviewView salonId="s1" />))).toContain("You have not added any products yet");
    install();
    const t = text(await mount(<OverviewView salonId="s1" />));
    expect(t).toMatch(/See\s+1\s+low on stock/);
    expect(t).toContain("Latest stock changes");
    // The Phase 2 dashboard: server figures only, and a nudge for visits without products recorded.
    expect(t).toContain("Products used (at cost)");
    expect(t).toContain("₹640");
    expect(t).toContain("Hair colour");
    expect(t).toMatch(/1\s+visit\s+in the last 7 days have no products recorded/);
  });
});
