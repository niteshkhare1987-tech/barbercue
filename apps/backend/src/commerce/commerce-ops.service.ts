import { createHash, randomBytes } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { strToU8, zipSync } from 'fflate';
import type { z } from 'zod';
import {
  Role,
  SETTLEMENT_COLUMNS,
  STOCK_IMPORT_COLUMNS,
  mapColumns,
  paise,
  parseSheetDate,
  parseSheetMoney,
  rupeesOf,
  type AuthenticatedUser,
  type CommerceListQuery,
  type CommerceSupplierReturnInput,
  type commerceAuditCountSchema,
  type commerceBulkTransitionSchema,
  type commercePickupSchema,
  type commercePurchaseRequestSchema,
  type commerceQuotationSchema,
  type commerceWarehouseGrantSchema,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { readSpreadsheet } from '../inventory/upload/spreadsheet-reader';
import { PrismaService } from '../prisma/prisma.service';
import { CommerceAdminService } from './commerce-admin.service';
import { CommerceOrdersService } from './commerce-orders.service';
import { CommerceStockService } from './commerce-stock.service';
import {
  TX_OPTIONS,
  conflict,
  dateOnly,
  fail,
  indiaToday,
  money,
  notFound,
  type Db,
} from './commerce-support';

const MAX_ROWS = 2000;
const code = (p: string) =>
  `${p}-${randomBytes(4).toString('hex').toUpperCase()}`;
const todayText = () => indiaToday().toISOString().slice(0, 10);

/** Reads the first sheet as plain text rows with a header line. */
function sheetRows(file: Express.Multer.File | undefined): {
  rows: string[][];
  hash: string;
  name: string;
} {
  if (!file?.buffer?.length)
    throw fail('COMMERCE_FILE', 'Choose a .csv or .xlsx file.');
  const book = readSpreadsheet(file.buffer, file.originalname);
  const rows = (book.sheets[0]?.rows ?? [])
    .map((r) => Array.from(r, (c) => (c?.text ?? '').trim()))
    .filter((r) => r.some(Boolean));
  if (rows.length < 2)
    throw fail('COMMERCE_FILE', 'The file has no rows below its headings.');
  if (rows.length - 1 > MAX_ROWS)
    throw fail('COMMERCE_FILE', `At most ${MAX_ROWS} rows per file.`);
  return {
    rows,
    hash: createHash('sha256').update(file.buffer).digest('hex'),
    name: file.originalname.slice(0, 200),
  };
}

type Cell = string | number | boolean | Date | null | undefined;
/** A minimal one-sheet .xlsx: text is always stored as text, so no cell can act as a formula. */
export function toXlsx(rows: Array<Record<string, Cell>>): Buffer {
  const esc = (s: string) =>
    s
      // Characters XML 1.0 does not allow.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const head = rows.length ? Object.keys(rows[0]) : [];
  const cell = (v: Cell) =>
    typeof v === 'number' && Number.isFinite(v)
      ? `<c><v>${v}</v></c>`
      : `<c t="inlineStr"><is><t xml:space="preserve">${esc(v == null ? '' : v instanceof Date ? v.toISOString() : String(v)).slice(0, 32000)}</t></is></c>`;
  const row = (cells: Cell[]) => `<row>${cells.map(cell).join('')}</row>`;
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = 'http://schemas.openxmlformats.org';
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `${xml}<Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `${xml}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
      'xl/workbook.xml': strToU8(
        `${xml}<workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="FastQue" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `${xml}<Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        `${xml}<worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${row(head)}${rows.map((r) => row(head.map((h) => r[h]))).join('')}</sheetData></worksheet>`,
      ),
    }),
  );
}

/** Back-office operations: imports, audits, warehouse limits, procurement requests, pickups. */
@Injectable()
export class CommerceOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: CommerceStockService,
    private readonly orders: CommerceOrdersService,
    private readonly admin: CommerceAdminService,
  ) {}

  private audit(
    db: Db,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject = {},
  ) {
    return db.auditLog.create({
      data: { actorUserId, action, entityType, entityId, metadata },
    });
  }

  // ---------- Warehouse limits ----------

  /** null = every warehouse. */
  async scope(user: AuthenticatedUser): Promise<string[] | null> {
    if (user.roles.includes(Role.PLATFORM_ADMIN)) return null;
    const rows = await this.prisma.commerceWarehouseGrant.findMany({
      where: { userId: user.id },
    });
    return rows.length ? rows.map((r) => r.warehouseId) : null;
  }
  async assertWarehouse(user: AuthenticatedUser, ...ids: string[]) {
    const allowed = await this.scope(user);
    if (allowed && ids.some((i) => !allowed.includes(i)))
      throw fail(
        'COMMERCE_WAREHOUSE_FORBIDDEN',
        'Your account is limited to other warehouses.',
        HttpStatus.FORBIDDEN,
      );
  }
  async assertBatch(user: AuthenticatedUser, batchId: string) {
    const b = await this.prisma.commerceBatch.findUnique({
      where: { id: batchId },
      select: { warehouseId: true },
    });
    if (!b) throw notFound('The batch');
    await this.assertWarehouse(user, b.warehouseId);
  }
  async assertOrder(user: AuthenticatedUser, orderId: string) {
    const o = await this.prisma.commerceOrder.findUnique({
      where: { id: orderId },
      select: { warehouseId: true },
    });
    if (!o) throw notFound('The order');
    await this.assertWarehouse(user, o.warehouseId);
  }
  warehouseGrants() {
    return this.prisma.commerceWarehouseGrant.findMany({ take: 1000 });
  }
  async setWarehouseGrants(
    input: z.infer<typeof commerceWarehouseGrantSchema>,
    by: string,
  ) {
    const ids = [...new Set(input.warehouseIds)];
    if (
      (await this.prisma.commerceWarehouse.count({
        where: { id: { in: ids } },
      })) !== ids.length
    )
      throw notFound('A warehouse');
    await this.prisma.$transaction(async (tx) => {
      await tx.commerceWarehouseGrant.deleteMany({
        where: { userId: input.userId },
      });
      await tx.commerceWarehouseGrant.createMany({
        data: ids.map((warehouseId) => ({ userId: input.userId, warehouseId })),
      });
      await this.audit(
        tx,
        by,
        'COMMERCE_WAREHOUSE_LIMIT_SET',
        'User',
        input.userId,
        { warehouses: ids.length },
      );
    });
  }

  // ---------- Stock import ----------

  async importStock(
    user: AuthenticatedUser,
    file: Express.Multer.File | undefined,
    apply: boolean,
  ) {
    const { rows, hash } = sheetRows(file);
    const cols = mapColumns(rows[0], STOCK_IMPORT_COLUMNS);
    const missing = (
      ['code', 'warehouse', 'batch', 'unitCost', 'quantity'] as const
    ).filter((k) => cols[k] === undefined);
    if (missing.length)
      throw fail(
        'COMMERCE_FILE',
        `Missing columns: ${missing.join(', ')}. Use SKU or barcode, warehouse, batch, expiry, cost and quantity.`,
      );
    const [listings, warehouses, allowed] = await Promise.all([
      this.prisma.commerceListing.findMany({
        include: {
          globalProduct: {
            select: { name: true, barcodes: { select: { code: true } } },
          },
        },
        take: 10000,
      }),
      this.prisma.commerceWarehouse.findMany({ where: { isActive: true } }),
      this.scope(user),
    ]);
    const bySku = new Map(listings.map((l) => [l.sku.toLowerCase(), l]));
    const byCode = new Map(
      listings.flatMap((l) =>
        l.globalProduct.barcodes.map(
          (b) => [b.code.replace(/^0+/, ''), l] as const,
        ),
      ),
    );
    const byWh = new Map(warehouses.map((w) => [w.code.toLowerCase(), w]));
    const today = todayText();
    const out = rows.slice(1).map((r, i) => {
      const v = (k: keyof typeof STOCK_IMPORT_COLUMNS) =>
        cols[k] === undefined ? '' : (r[cols[k]] ?? '');
      const problems: string[] = [];
      const key = v('code');
      const listing =
        bySku.get(key.toLowerCase()) ??
        byCode.get(key.replace(/\D/g, '').replace(/^0+/, '') || '-');
      if (!listing) problems.push('Unknown SKU or barcode');
      const wh = byWh.get(v('warehouse').toLowerCase());
      if (!wh) problems.push('Unknown warehouse code');
      else if (allowed && !allowed.includes(wh.id))
        problems.push('Not your warehouse');
      const batchNumber = v('batch').slice(0, 60);
      if (!batchNumber) problems.push('Batch number is empty');
      const expiresOn = v('expiresOn') ? parseSheetDate(v('expiresOn')) : null;
      if (v('expiresOn') && !expiresOn)
        problems.push('Expiry date not understood');
      if (expiresOn && expiresOn <= today) problems.push('Already expired');
      if (listing?.expiryTracked && !v('expiresOn'))
        problems.push('Expiry date needed');
      const manufacturedOn = v('manufacturedOn')
        ? parseSheetDate(v('manufacturedOn'))
        : null;
      if (v('manufacturedOn') && !manufacturedOn)
        problems.push('Manufacturing date not understood');
      if (manufacturedOn && expiresOn && manufacturedOn >= expiresOn)
        problems.push('Manufactured after expiry');
      const unitCost = parseSheetMoney(v('unitCost'));
      if (unitCost == null) problems.push('Cost not understood');
      const quantity = /^\d{1,7}(\.0+)?$/.test(v('quantity'))
        ? Number(v('quantity'))
        : 0;
      if (quantity < 1 || quantity > 1_000_000)
        problems.push('Quantity must be a whole number above 0');
      return {
        row: i + 2,
        code: key,
        product: listing?.globalProduct.name ?? null,
        listingId: listing?.id ?? null,
        warehouse: wh?.code ?? v('warehouse'),
        warehouseId: wh?.id ?? null,
        batchNumber,
        manufacturedOn,
        expiresOn,
        unitCost,
        quantity,
        problems,
      };
    });
    const bad = out.filter((r) => r.problems.length).length;
    if (!apply) return { rows: out, problems: bad, applied: false };
    if (bad)
      throw conflict(
        'COMMERCE_FILE',
        `${bad} row(s) have problems. Fix the file and upload it again; nothing was added.`,
      );
    const key = (row: number) => `imp:${hash.slice(0, 40)}:${row}`;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce-import:${hash}`}, 0))`,
        );
        if (
          await tx.commerceStockMovement.findUnique({
            where: { idempotencyKey: key(out[0].row) },
          })
        )
          throw conflict(
            'COMMERCE_FILE',
            'This exact file was already imported.',
          );
        for (const r of out)
          await this.stock.stockIn(
            tx,
            {
              listingId: r.listingId!,
              warehouseId: r.warehouseId!,
              batchNumber: r.batchNumber,
              manufacturedOn: r.manufacturedOn,
              expiresOn: r.expiresOn,
              unitCost: r.unitCost!,
              quantity: r.quantity,
              note: 'File import',
            },
            'OPENING',
            user.id,
            { idempotencyKey: key(r.row) },
          );
        await this.audit(
          tx,
          user.id,
          'COMMERCE_STOCK_IMPORTED',
          'CommerceBatch',
          hash.slice(0, 36),
          { rows: out.length },
        );
      },
      { ...TX_OPTIONS, timeout: 120_000 },
    );
    return { rows: out, problems: 0, applied: true };
  }

  // ---------- COD settlement import ----------

  async importSettlement(
    user: AuthenticatedUser,
    courier: string,
    file: Express.Multer.File | undefined,
  ) {
    const { rows, hash, name } = sheetRows(file);
    const cols = mapColumns(rows[0], SETTLEMENT_COLUMNS);
    if (cols.match === undefined || cols.amount === undefined)
      throw fail(
        'COMMERCE_FILE',
        'The file needs an order or tracking number column and an amount column.',
      );
    const at = (r: string[], k: keyof typeof SETTLEMENT_COLUMNS) =>
      cols[k] === undefined ? '' : (r[cols[k]] ?? '');
    const keys = rows.slice(1).map((r) => at(r, 'match').slice(0, 80));
    const found = await this.prisma.commerceOrder.findMany({
      where: {
        OR: [
          { orderNumber: { in: keys.map((k) => k.toUpperCase()) } },
          { shipments: { some: { trackingNumber: { in: keys } } } },
        ],
      },
      include: { shipments: true, codEntries: true },
    });
    const index = new Map<string, typeof found>();
    for (const o of found)
      for (const k of new Set([
        o.orderNumber,
        ...o.shipments.map((s) => s.trackingNumber ?? ''),
      ]))
        if (k) index.set(k, [...(index.get(k) ?? []), o]);
    const used = new Set<string>();
    const lines = rows.slice(1).map((r, i) => {
      const match = keys[i];
      const amount = parseSheetMoney(at(r, 'amount'));
      const deductions = at(r, 'deductions')
        ? parseSheetMoney(at(r, 'deductions'))
        : '0';
      const hits = index.get(match) ?? index.get(match.toUpperCase()) ?? [];
      const o = hits.length === 1 ? hits[0] : null;
      const settled = (o?.codEntries ?? [])
        .filter((e) => e.kind === 'SETTLED')
        .reduce((n, e) => n + paise(e.amount.toFixed(2)), 0);
      const due = o ? paise(o.total.toFixed(2)) - settled : 0;
      const problem =
        amount == null || deductions == null
          ? 'Amount not understood'
          : !hits.length
            ? 'No order with this number'
            : !o
              ? 'More than one order has this tracking number'
              : used.has(o.id)
                ? 'Same order twice in this file'
                : o.status !== 'DELIVERED'
                  ? `Order is ${o.status}, not delivered`
                  : due <= 0
                    ? 'Already settled'
                    : paise(amount) !== due
                      ? `Courier says ₹${amount}, ₹${rupeesOf(due)} is due`
                      : paise(deductions) > paise(amount)
                        ? 'Deductions are more than the amount'
                        : null;
      if (o) used.add(o.id);
      return {
        rowNumber: i + 2,
        matchText: match,
        amount: amount ?? '0',
        deductions: deductions ?? '0',
        reference: at(r, 'reference').slice(0, 80) || null,
        orderId: o?.id ?? null,
        state: problem ? 'PROBLEM' : 'MATCHED',
        message: problem,
      };
    });
    const existing = await this.prisma.commerceSettlementImport.findUnique({
      where: { fileHash: hash },
    });
    if (existing)
      throw conflict('COMMERCE_FILE', 'This exact file was already uploaded.');
    const row = await this.prisma.commerceSettlementImport.create({
      data: {
        courier,
        fileName: name,
        fileHash: hash,
        createdByUserId: user.id,
        lines: { create: lines },
      },
    });
    await this.audit(
      this.prisma,
      user.id,
      'COMMERCE_SETTLEMENT_UPLOADED',
      'CommerceSettlementImport',
      row.id,
      { rows: lines.length },
    );
    return this.settlement(row.id);
  }
  async settlement(id: string) {
    const r = await this.prisma.commerceSettlementImport.findUnique({
      where: { id },
      include: { lines: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!r) throw notFound('The settlement file');
    return r;
  }
  settlements() {
    return this.prisma.commerceSettlementImport.findMany({
      orderBy: { createdAt: 'desc' },
      include: { lines: { orderBy: { rowNumber: 'asc' } } },
      take: 20,
    });
  }
  /** Records the matched lines in the cash ledger. Sign-off stays a separate, human step. */
  async applySettlement(id: string, user: AuthenticatedUser) {
    const imp = await this.settlement(id);
    for (const l of imp.lines) {
      if (l.state !== 'MATCHED' || !l.orderId) continue;
      try {
        const o = await this.prisma.commerceOrder.findUniqueOrThrow({
          where: { id: l.orderId },
          include: { codEntries: true },
        });
        const collected = o.codEntries
          .filter((e) => e.kind === 'COLLECTED')
          .reduce((n, e) => n + paise(e.amount.toFixed(2)), 0);
        const gap = paise(o.total.toFixed(2)) - collected;
        const common = {
          reference: l.reference,
          occurredOn: todayText(),
          note: `${imp.courier} settlement file`,
        };
        // The courier's remittance is the evidence that the cash was collected.
        if (gap > 0)
          await this.orders.recordCod(
            o.id,
            {
              ...common,
              kind: 'COLLECTED',
              amount: rupeesOf(gap),
              deductions: '0',
            },
            user.id,
            `stl:${l.id}:c`,
          );
        await this.orders.recordCod(
          o.id,
          {
            ...common,
            kind: 'SETTLED',
            amount: money(l.amount),
            deductions: money(l.deductions),
          },
          user.id,
          `stl:${l.id}:s`,
        );
        await this.prisma.commerceSettlementLine.update({
          where: { id: l.id },
          data: { state: 'APPLIED', message: null },
        });
      } catch (e) {
        if (!(e instanceof AppException)) throw e;
        await this.prisma.commerceSettlementLine.update({
          where: { id: l.id },
          data: { state: 'PROBLEM', message: e.message.slice(0, 300) },
        });
      }
    }
    await this.prisma.commerceSettlementImport.update({
      where: { id },
      data: { appliedAt: imp.appliedAt ?? new Date() },
    });
    await this.audit(
      this.prisma,
      user.id,
      'COMMERCE_SETTLEMENT_APPLIED',
      'CommerceSettlementImport',
      id,
    );
    return this.settlement(id);
  }

  // ---------- Bulk order steps ----------

  async bulk(
    input: z.infer<typeof commerceBulkTransitionSchema>,
    user: AuthenticatedUser,
  ) {
    const results: Array<{ orderId: string; ok: boolean; message?: string }> =
      [];
    for (const orderId of new Set(input.orderIds)) {
      try {
        await this.assertOrder(user, orderId);
        await this.orders.transition(
          orderId,
          { to: input.to },
          'STAFF',
          user.id,
        );
        results.push({ orderId, ok: true });
      } catch (e) {
        if (!(e instanceof AppException)) throw e;
        results.push({ orderId, ok: false, message: e.message });
      }
    }
    return { results, done: results.filter((r) => r.ok).length };
  }

  // ---------- Stock audits ----------

  async audits(user: AuthenticatedUser) {
    const allowed = await this.scope(user);
    return this.prisma.commerceStockAudit.findMany({
      where: allowed ? { warehouseId: { in: allowed } } : {},
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { lines: true } } },
      take: 50,
    });
  }
  async openAudit(warehouseId: string, user: AuthenticatedUser) {
    await this.assertWarehouse(user, warehouseId);
    const batches = await this.prisma.commerceBatch.findMany({
      where: { warehouseId, onHand: { gt: 0 } },
      select: { id: true },
      take: 5000,
    });
    if (!batches.length)
      throw conflict('COMMERCE_AUDIT', 'This warehouse has no stock to count.');
    const a = await this.prisma.commerceStockAudit.create({
      data: {
        number: code('FQA'),
        warehouseId,
        createdByUserId: user.id,
        lines: { create: batches.map((b) => ({ batchId: b.id })) },
      },
    });
    await this.audit(
      this.prisma,
      user.id,
      'COMMERCE_AUDIT_OPENED',
      'CommerceStockAudit',
      a.id,
    );
    return this.auditSheet(a.id, user);
  }
  /** The count sheet hides the system quantity until the count is submitted. */
  async auditSheet(id: string, user: AuthenticatedUser) {
    const a = await this.prisma.commerceStockAudit.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!a) throw notFound('The stock count');
    await this.assertWarehouse(user, a.warehouseId);
    const batches = new Map(
      (
        await this.prisma.commerceBatch.findMany({
          where: { id: { in: a.lines.map((l) => l.batchId) } },
          select: {
            id: true,
            batchNumber: true,
            expiresOn: true,
            storageLocation: true,
            listing: {
              select: { sku: true, globalProduct: { select: { name: true } } },
            },
          },
        })
      ).map((b) => [b.id, b]),
    );
    const blind = a.status === 'OPEN';
    return {
      ...a,
      lines: a.lines
        .map((l) => {
          const b = batches.get(l.batchId)!;
          return {
            batchId: l.batchId,
            product: b.listing.globalProduct.name,
            sku: b.listing.sku,
            batchNumber: b.batchNumber,
            expiresOn: b.expiresOn,
            location: b.storageLocation,
            counted: l.counted,
            systemQty: blind ? null : l.systemQty,
            difference:
              blind || l.counted == null || l.systemQty == null
                ? null
                : l.counted - l.systemQty,
          };
        })
        .sort((x, y) => x.product.localeCompare(y.product)),
    };
  }
  async countAudit(
    id: string,
    input: z.infer<typeof commerceAuditCountSchema>,
    user: AuthenticatedUser,
  ) {
    const head = await this.prisma.commerceStockAudit.findUnique({
      where: { id },
    });
    if (!head) throw notFound('The stock count');
    await this.assertWarehouse(user, head.warehouseId);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "commerce_stock_audits" WHERE "id" = ${id}::uuid FOR UPDATE`,
      );
      const a = await tx.commerceStockAudit.findUniqueOrThrow({
        where: { id },
      });
      if (a.status !== 'OPEN')
        throw conflict('COMMERCE_AUDIT', 'This count is already submitted.');
      for (const l of input.lines) {
        const b = await tx.commerceBatch.findUnique({
          where: { id: l.batchId },
          select: { onHand: true },
        });
        const done = await tx.commerceStockAuditLine.updateMany({
          where: { auditId: id, batchId: l.batchId },
          data: { counted: l.counted, systemQty: b?.onHand ?? 0 },
        });
        if (!done.count) throw notFound('A batch on this count');
      }
      if (
        !(await tx.commerceStockAuditLine.count({
          where: { auditId: id, counted: null },
        }))
      )
        await tx.commerceStockAudit.update({
          where: { id },
          data: { status: 'SUBMITTED', countedByUserId: user.id },
        });
    }, TX_OPTIONS);
    return this.auditSheet(id, user);
  }
  /** A second person approves; differences go through the stock ledger, exactly once each. */
  async approveAudit(id: string, user: AuthenticatedUser) {
    const a = await this.prisma.commerceStockAudit.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!a) throw notFound('The stock count');
    await this.assertWarehouse(user, a.warehouseId);
    if (a.status === 'APPROVED') return { problems: [], approved: true };
    if (a.status !== 'SUBMITTED')
      throw conflict('COMMERCE_AUDIT', 'Count every batch first.');
    if (a.countedByUserId === user.id)
      throw fail(
        'COMMERCE_AUDIT_SECOND_PERSON',
        'Someone else must approve a count you submitted.',
        HttpStatus.FORBIDDEN,
      );
    const problems: string[] = [];
    for (const l of a.lines) {
      const diff = (l.counted ?? 0) - (l.systemQty ?? 0);
      if (!diff) continue;
      try {
        await this.stock.adjust(
          l.batchId,
          {
            kind: 'ADJUSTMENT',
            quantity: diff,
            note: `Stock count ${a.number}`,
          },
          user.id,
          `aud:${l.id}`,
        );
      } catch (e) {
        if (!(e instanceof AppException)) throw e;
        problems.push(e.message);
      }
    }
    if (!problems.length) {
      await this.prisma.commerceStockAudit.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedByUserId: user.id,
          approvedAt: new Date(),
        },
      });
      await this.audit(
        this.prisma,
        user.id,
        'COMMERCE_AUDIT_APPROVED',
        'CommerceStockAudit',
        id,
      );
    }
    return { problems, approved: !problems.length };
  }
  async cancelAudit(id: string, user: AuthenticatedUser) {
    const a = await this.prisma.commerceStockAudit.findUnique({
      where: { id },
    });
    if (!a) throw notFound('The stock count');
    await this.assertWarehouse(user, a.warehouseId);
    const posted = await this.prisma.commerceStockAuditLine.findMany({
      where: { auditId: id },
      select: { id: true },
    });
    if (
      await this.prisma.commerceStockMovement.count({
        where: { idempotencyKey: { in: posted.map((p) => `aud:${p.id}`) } },
      })
    )
      throw conflict(
        'COMMERCE_AUDIT',
        'Some differences were already posted; finish approving this count.',
      );
    const done = await this.prisma.commerceStockAudit.updateMany({
      where: { id, status: { in: ['OPEN', 'SUBMITTED'] } },
      data: { status: 'CANCELLED' },
    });
    if (!done.count)
      throw conflict('COMMERCE_AUDIT', 'This count cannot be cancelled.');
  }

  // ---------- Purchase requests, quotations, supplier returns ----------

  async requests() {
    const rows = await this.prisma.commercePurchaseRequest.findMany({
      orderBy: { createdAt: 'desc' },
      include: { quotations: { orderBy: { unitCost: 'asc' } } },
      take: 100,
    });
    const listings = new Map(
      (
        await this.prisma.commerceListing.findMany({
          where: { id: { in: rows.map((r) => r.listingId) } },
          select: {
            id: true,
            sku: true,
            globalProduct: { select: { name: true } },
          },
        })
      ).map((l) => [l.id, l]),
    );
    const suppliers = new Map(
      (
        await this.prisma.commerceSupplier.findMany({
          select: { id: true, name: true },
        })
      ).map((s) => [s.id, s.name]),
    );
    return rows.map((r) => ({
      ...r,
      product: listings.get(r.listingId)?.globalProduct.name ?? '',
      quotations: r.quotations.map((q) => ({
        ...q,
        unitCost: money(q.unitCost),
        supplier: suppliers.get(q.supplierId) ?? '',
      })),
    }));
  }
  async createRequest(
    input: z.infer<typeof commercePurchaseRequestSchema>,
    user: AuthenticatedUser,
  ) {
    await this.assertWarehouse(user, input.warehouseId);
    const [l, w] = await Promise.all([
      this.prisma.commerceListing.findUnique({
        where: { id: input.listingId },
      }),
      this.prisma.commerceWarehouse.findUnique({
        where: { id: input.warehouseId },
      }),
    ]);
    if (!l || !w) throw notFound(l ? 'The warehouse' : 'The product');
    const r = await this.prisma.commercePurchaseRequest.create({
      data: { ...input, number: code('FQRQ'), createdByUserId: user.id },
    });
    await this.audit(
      this.prisma,
      user.id,
      'COMMERCE_REQUEST_CREATED',
      'CommercePurchaseRequest',
      r.id,
    );
    return r;
  }
  async quote(
    requestId: string,
    input: z.infer<typeof commerceQuotationSchema>,
  ) {
    const r = await this.prisma.commercePurchaseRequest.findUnique({
      where: { id: requestId },
    });
    if (!r) throw notFound('The request');
    if (!['OPEN', 'APPROVED'].includes(r.status))
      throw conflict('COMMERCE_REQUEST', `This request is ${r.status}.`);
    if (
      !(await this.prisma.commerceSupplier.findUnique({
        where: { id: input.supplierId },
      }))
    )
      throw notFound('The supplier');
    const q = await this.prisma.commerceQuotation.create({
      data: {
        ...input,
        requestId,
        validUntil: input.validUntil ? dateOnly(input.validUntil) : null,
      },
    });
    return { id: q.id };
  }
  async actOnRequest(
    id: string,
    action: 'APPROVE' | 'REJECT' | 'ORDER',
    quotationId: string | undefined,
    by: string,
  ) {
    if (action !== 'ORDER') {
      const done = await this.prisma.commercePurchaseRequest.updateMany({
        where: { id, status: 'OPEN' },
        data: {
          status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decidedByUserId: by,
        },
      });
      if (!done.count)
        throw conflict('COMMERCE_REQUEST', 'This request is already decided.');
      await this.audit(
        this.prisma,
        by,
        `COMMERCE_REQUEST_${action}`,
        'CommercePurchaseRequest',
        id,
      );
      return { id };
    }
    const q = quotationId
      ? await this.prisma.commerceQuotation.findFirst({
          where: { id: quotationId, requestId: id },
        })
      : null;
    if (!q)
      throw fail('COMMERCE_REQUEST', 'Choose the quotation to order from.');
    if (q.validUntil && q.validUntil < indiaToday())
      throw conflict('COMMERCE_REQUEST', 'This quotation has expired.');
    const po = await this.prisma.$transaction(async (tx) => {
      // Claiming first means two clicks cannot create two purchase orders.
      const claimed = await tx.commercePurchaseRequest.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'ORDERED' },
      });
      if (!claimed.count)
        throw conflict('COMMERCE_REQUEST', 'Approve this request first.');
      const r = await tx.commercePurchaseRequest.findUniqueOrThrow({
        where: { id },
      });
      const created = await tx.commercePurchaseOrder.create({
        data: {
          number: code('FQPO'),
          supplierId: q.supplierId,
          warehouseId: r.warehouseId,
          note: `From request ${r.number}`,
          createdByUserId: by,
          items: {
            create: [
              {
                listingId: r.listingId,
                quantity: r.quantity,
                unitCost: q.unitCost,
              },
            ],
          },
        },
      });
      await tx.commercePurchaseRequest.update({
        where: { id },
        data: { purchaseOrderId: created.id },
      });
      await this.audit(
        tx,
        by,
        'COMMERCE_REQUEST_ORDER',
        'CommercePurchaseRequest',
        id,
        { po: created.number },
      );
      return created;
    }, TX_OPTIONS);
    return { id, purchaseOrder: po.number };
  }

  async purchaseOrderDocument(id: string) {
    const po = await this.prisma.commercePurchaseOrder.findUnique({
      where: { id },
      include: {
        supplier: true,
        items: {
          include: {
            listing: {
              select: { sku: true, globalProduct: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!po) throw notFound('The purchase order');
    const [seller, warehouse] = await Promise.all([
      this.admin.fastque(),
      this.prisma.commerceWarehouse.findUnique({
        where: { id: po.warehouseId },
      }),
    ]);
    return {
      number: po.number,
      status: po.status,
      createdAt: po.createdAt,
      expectedOn: po.expectedOn,
      note: po.note,
      buyer: {
        name: seller.legalName ?? seller.displayName,
        gstin: seller.gstin,
        address: seller.address,
      },
      supplier: {
        name: po.supplier.name,
        gstin: po.supplier.gstin,
        address: po.supplier.address,
      },
      deliverTo: warehouse
        ? [warehouse.name, warehouse.address, warehouse.city, warehouse.pincode]
            .filter(Boolean)
            .join(', ')
        : '',
      items: po.items.map((i) => ({
        sku: i.listing.sku,
        name: i.listing.globalProduct.name,
        quantity: i.quantity,
        unitCost: money(i.unitCost),
        total: rupeesOf(paise(i.unitCost.toFixed(2)) * i.quantity),
      })),
      total: rupeesOf(
        po.items.reduce(
          (n, i) => n + paise(i.unitCost.toFixed(2)) * i.quantity,
          0,
        ),
      ),
    };
  }

  async supplierReturns() {
    const rows = await this.prisma.commerceSupplierReturn.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const [batches, suppliers] = await Promise.all([
      this.prisma.commerceBatch.findMany({
        where: { id: { in: rows.map((r) => r.batchId) } },
        select: {
          id: true,
          batchNumber: true,
          listing: { select: { globalProduct: { select: { name: true } } } },
        },
      }),
      this.prisma.commerceSupplier.findMany({
        where: { id: { in: rows.map((r) => r.supplierId) } },
        select: { id: true, name: true },
      }),
    ]);
    return rows.map((r) => {
      const b = batches.find((x) => x.id === r.batchId);
      return {
        ...r,
        supplier: suppliers.find((s) => s.id === r.supplierId)?.name ?? '',
        product: b?.listing.globalProduct.name ?? '',
        batchNumber: b?.batchNumber ?? '',
      };
    });
  }
  async returnToSupplier(
    input: CommerceSupplierReturnInput,
    user: AuthenticatedUser,
    key: string,
  ) {
    await this.assertBatch(user, input.batchId);
    const supplier = await this.prisma.commerceSupplier.findUnique({
      where: { id: input.supplierId },
    });
    if (!supplier) throw notFound('The supplier');
    return this.prisma.$transaction(async (tx) => {
      const done = await tx.commerceStockMovement.findUnique({
        where: { idempotencyKey: key },
      });
      if (done)
        return tx.commerceSupplierReturn.findFirstOrThrow({
          where: { number: done.reference ?? '' },
        });
      const number = code('FQSR');
      await this.stock.leaveToSupplier(
        tx,
        input.batchId,
        input.source,
        input.quantity,
        number,
        user.id,
        key,
      );
      const r = await tx.commerceSupplierReturn.create({
        data: { ...input, number, createdByUserId: user.id },
      });
      await this.audit(
        tx,
        user.id,
        'COMMERCE_SUPPLIER_RETURN',
        'CommerceSupplierReturn',
        r.id,
        { quantity: input.quantity },
      );
      return r;
    }, TX_OPTIONS);
  }
  async creditSupplierReturn(
    id: string,
    amount: string,
    reference: string | null,
    by: string,
  ) {
    const done = await this.prisma.commerceSupplierReturn.updateMany({
      where: { id, status: 'SENT' },
      data: {
        status: 'CREDITED',
        creditAmount: amount,
        creditReference: reference,
      },
    });
    if (!done.count)
      throw conflict(
        'COMMERCE_SUPPLIER_RETURN',
        'This return is already credited.',
      );
    await this.audit(
      this.prisma,
      by,
      'COMMERCE_SUPPLIER_CREDIT',
      'CommerceSupplierReturn',
      id,
      { amount },
    );
  }

  // ---------- Pickups ----------

  async pickups(user: AuthenticatedUser) {
    const allowed = await this.scope(user);
    return this.prisma.commercePickup.findMany({
      where: allowed ? { warehouseId: { in: allowed } } : {},
      orderBy: [{ pickupOn: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }
  async createPickup(
    input: z.infer<typeof commercePickupSchema>,
    user: AuthenticatedUser,
  ) {
    await this.assertWarehouse(user, input.warehouseId);
    const orderIds = [...new Set(input.orderIds)];
    if (input.pickupOn < todayText())
      throw fail('COMMERCE_PICKUP', 'Choose today or a later date.');
    const ok = await this.prisma.commerceOrder.count({
      where: {
        id: { in: orderIds },
        warehouseId: input.warehouseId,
        status: 'PACKED',
      },
    });
    if (ok !== orderIds.length)
      throw conflict(
        'COMMERCE_PICKUP',
        'Every order must be packed at this warehouse.',
      );
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce-pickup:${input.warehouseId}`}, 0))`,
      );
      if (
        await tx.commercePickup.findFirst({
          where: { status: 'SCHEDULED', orderIds: { hasSome: orderIds } },
        })
      )
        throw conflict(
          'COMMERCE_PICKUP',
          'One of these orders is already in a scheduled pickup.',
        );
      const p = await tx.commercePickup.create({
        data: {
          ...input,
          orderIds,
          number: code('FQPU'),
          pickupOn: dateOnly(input.pickupOn),
          createdByUserId: user.id,
        },
      });
      await this.audit(
        tx,
        user.id,
        'COMMERCE_PICKUP_SCHEDULED',
        'CommercePickup',
        p.id,
        { orders: orderIds.length },
      );
      return p;
    }, TX_OPTIONS);
  }
  async actOnPickup(
    id: string,
    status: 'PICKED_UP' | 'CANCELLED',
    user: AuthenticatedUser,
  ) {
    const p = await this.prisma.commercePickup.findUnique({ where: { id } });
    if (!p) throw notFound('The pickup');
    await this.assertWarehouse(user, p.warehouseId);
    const done = await this.prisma.commercePickup.updateMany({
      where: { id, status: 'SCHEDULED' },
      data: { status },
    });
    if (!done.count)
      throw conflict('COMMERCE_PICKUP', 'This pickup is already finished.');
    await this.audit(
      this.prisma,
      user.id,
      `COMMERCE_PICKUP_${status}`,
      'CommercePickup',
      id,
    );
  }

  exportRows(q: CommerceListQuery, finance: boolean) {
    return this.admin.exportOrders(q, finance);
  }
}
