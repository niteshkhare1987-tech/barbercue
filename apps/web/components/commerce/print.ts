"use client";

/** Opens a plain printable page. The browser's own "Save as PDF" makes the PDF; every value is escaped. */
export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function printDocument(title: string, pages: string[]) {
  const w = window.open("", "_blank");
  if (!w) {
    window.alert("Allow pop-ups for this site to print.");
    return;
  }
  w.opener = null;
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;color:#000;background:#fff;margin:24px}h1{font-size:20px;margin:0 0 8px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}td.n,th.n{text-align:right}.cols{display:flex;gap:32px;flex-wrap:wrap}.page{break-after:page;margin-bottom:32px}.page:last-child{break-after:auto}.label{border:2px solid #000;padding:16px;max-width:420px}.big{font-size:22px;font-weight:700}</style></head><body>${pages.map((p) => `<section class="page">${p}</section>`).join("")}</body></html>`,
  );
  w.document.close();
  w.focus();
  w.print();
}

export interface InvoiceDto {
  orderNumber: string;
  placedAt: string;
  seller: { name: string; legalName: string | null; gstin: string | null; address: string | null };
  billTo: Record<string, string | null>;
  items: Array<{ name: string; hsn: string | null; quantity: number; unitPrice: string; lineTotal: string; gstRate: string | null }>;
  subtotal: string;
  discount: string;
  delivery: string;
  taxIncluded: string;
  total: string;
  taxInvoiceReady: boolean;
}
const place = (a: Record<string, string | null>) => [a.name, a.line1, a.line2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).map(esc).join("<br>");

export function invoicePage(i: InvoiceDto): string {
  return `<h1>Bill for order ${esc(i.orderNumber)}</h1><p>${esc(new Date(i.placedAt).toLocaleDateString("en-IN"))} · Cash on Delivery</p>
<div class="cols"><div><strong>Sold by</strong><br>${esc(i.seller.legalName ?? i.seller.name)}<br>${esc(i.seller.address ?? "")}${i.seller.gstin ? `<br>GSTIN ${esc(i.seller.gstin)}` : ""}</div><div><strong>Bill to</strong><br>${place(i.billTo)}</div></div>
<table><thead><tr><th>Product</th><th>HSN</th><th class="n">Qty</th><th class="n">Price ₹</th><th class="n">GST %</th><th class="n">Total ₹</th></tr></thead><tbody>${i.items.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.hsn)}</td><td class="n">${esc(x.quantity)}</td><td class="n">${esc(x.unitPrice)}</td><td class="n">${esc(x.gstRate)}</td><td class="n">${esc(x.lineTotal)}</td></tr>`).join("")}</tbody></table>
<p>Products ₹${esc(i.subtotal)} − discount ₹${esc(i.discount)} + delivery ₹${esc(i.delivery)} = <strong>₹${esc(i.total)}</strong><br>GST included in the products: ₹${esc(i.taxIncluded)}</p>
${i.taxInvoiceReady ? "" : "<p>This is an order bill, not a GST tax invoice: the seller's tax details are not complete.</p>"}`;
}

export interface SlipOrder {
  orderNumber: string;
  contactPhone: string;
  shippingAddress: unknown;
  instructions: string | null;
  amountDue: string;
  items: Array<{ name: string; sku: string; quantity: number }>;
}
export const slipPage = (o: SlipOrder) =>
  `<h1>Packing slip ${esc(o.orderNumber)}</h1><p>${place(o.shippingAddress as Record<string, string | null>)}</p>${o.instructions ? `<p>Instructions: ${esc(o.instructions)}</p>` : ""}<table><thead><tr><th>Product</th><th>SKU</th><th class="n">Qty</th></tr></thead><tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td class="n">${esc(i.quantity)}</td></tr>`).join("")}</tbody></table>`;
/** An address label for the parcel. It carries no courier barcode: no courier account is connected. */
export const labelPage = (o: SlipOrder) =>
  `<div class="label"><div>TO</div><div class="big">${place(o.shippingAddress as Record<string, string | null>)}</div><p>Phone ${esc(o.contactPhone)}</p><p>${esc(o.orderNumber)}</p><p class="big">${Number(o.amountDue) > 0 ? `Collect ₹${esc(o.amountDue)}` : "Nothing to collect"}</p></div>`;

export interface PoDocument {
  number: string;
  status: string;
  createdAt: string;
  expectedOn: string | null;
  note: string | null;
  buyer: { name: string; gstin: string | null; address: string | null };
  supplier: { name: string; gstin: string | null; address: string | null };
  deliverTo: string;
  items: Array<{ sku: string; name: string; quantity: number; unitCost: string; total: string }>;
  total: string;
}
export const poPage = (p: PoDocument) =>
  `<h1>Purchase order ${esc(p.number)}</h1><p>${esc(new Date(p.createdAt).toLocaleDateString("en-IN"))} · ${esc(p.status)}${p.expectedOn ? ` · expected ${esc(p.expectedOn.slice(0, 10))}` : ""}</p><div class="cols"><div><strong>Buyer</strong><br>${esc(p.buyer.name)}<br>${esc(p.buyer.address)}<br>${esc(p.buyer.gstin)}</div><div><strong>Supplier</strong><br>${esc(p.supplier.name)}<br>${esc(p.supplier.address)}<br>${esc(p.supplier.gstin)}</div><div><strong>Deliver to</strong><br>${esc(p.deliverTo)}</div></div><table><thead><tr><th>Product</th><th>SKU</th><th class="n">Qty</th><th class="n">Cost ₹</th><th class="n">Total ₹</th></tr></thead><tbody>${p.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td class="n">${i.quantity}</td><td class="n">${esc(i.unitCost)}</td><td class="n">${esc(i.total)}</td></tr>`).join("")}</tbody></table><p><strong>Total ₹${esc(p.total)}</strong></p>${p.note ? `<p>${esc(p.note)}</p>` : ""}`;
