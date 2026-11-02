import { createHash } from 'crypto';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  InventoryErrorCode,
  convertToStockUnit,
  type InventoryUnit,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';

type Tx = Prisma.TransactionClient;

export const COMMERCE_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 15000,
};

export const money = (v: Prisma.Decimal | number | null | undefined) =>
  new Prisma.Decimal(v ?? 0).toFixed(2);

/**
 * One inventory ledger entry inside the caller's transaction, at most once per idempotency key:
 * the product row is locked, stock may never go below zero, and the database trigger keeps
 * stock and average cost — the same rules as InventoryService.createMovement.
 */
export async function writeMovement(
  tx: Tx,
  input: {
    salonId: string;
    productId: string;
    actorUserId: string;
    kind: 'PURCHASE' | 'CONSUMPTION' | 'ADJUSTMENT';
    quantityDelta: Prisma.Decimal;
    unitCost?: Prisma.Decimal | null;
    supplierId?: string | null;
    reason?: string | null;
    reference?: string | null;
    batchNumber?: string | null;
    expiryDate?: Date | null;
    key: string;
  },
): Promise<string> {
  const existing = await tx.inventoryMovement.findUnique({
    where: {
      salonId_idempotencyKey: {
        salonId: input.salonId,
        idempotencyKey: input.key,
      },
    },
    select: { id: true },
  });
  if (existing) return existing.id;
  const [row] = await tx.$queryRaw<
    Array<{ stockOnHand: Prisma.Decimal; name: string }>
  >(Prisma.sql`SELECT "stockOnHand", "name" FROM "inventory_products"
    WHERE "id" = ${input.productId} AND "salonId" = ${input.salonId} FOR UPDATE`);
  if (!row)
    throw new AppException(
      InventoryErrorCode.PRODUCT_NOT_FOUND,
      'Inventory product not found.',
      HttpStatus.NOT_FOUND,
    );
  if (row.stockOnHand.plus(input.quantityDelta).lessThan(0))
    throw new AppException(
      InventoryErrorCode.INSUFFICIENT_STOCK,
      `Not enough ${row.name} in stock (${row.stockOnHand.toFixed(3)} left).`,
      HttpStatus.CONFLICT,
    );
  const movement = await tx.inventoryMovement.create({
    data: {
      salonId: input.salonId,
      productId: input.productId,
      actorUserId: input.actorUserId,
      kind: input.kind,
      quantityDelta: input.quantityDelta,
      unitCost: input.unitCost ?? null,
      supplierId: input.supplierId ?? null,
      reason: input.reason?.slice(0, 300) ?? null,
      reference: input.reference?.slice(0, 120) ?? null,
      batchNumber: input.batchNumber ?? null,
      expiryDate: input.expiryDate ?? null,
      idempotencyKey: input.key.slice(0, 128),
      requestHash: createHash('sha256').update(input.key).digest('hex'),
    },
    select: { id: true },
  });
  return movement.id;
}

/**
 * The salon's product for a catalog product on a shelf, created (counted in pieces, with the
 * catalog pack as its contents) when the salon doesn't stock it yet.
 */
export async function ensureSalonProduct(
  tx: Tx,
  salonId: string,
  globalProductId: string,
  usage: 'PROFESSIONAL' | 'RETAIL',
): Promise<{
  id: string;
  unit: InventoryUnit;
  contentSize: Prisma.Decimal | null;
  contentUnit: InventoryUnit | null;
}> {
  const select = {
    id: true,
    unit: true,
    contentSize: true,
    contentUnit: true,
  } as const;
  const found = await tx.inventoryProduct.findFirst({
    where: { salonId, globalProductId, usage },
    select,
  });
  if (found) return found;
  const catalog = await tx.globalProduct.findUniqueOrThrow({
    where: { id: globalProductId },
    select: { name: true, packSize: true, packUnit: true },
  });
  const content =
    catalog.packSize?.greaterThan(0) &&
    catalog.packUnit &&
    ['GRAM', 'KILOGRAM', 'MILLILITER', 'LITER', 'EACH'].includes(
      catalog.packUnit,
    )
      ? { contentSize: catalog.packSize, contentUnit: catalog.packUnit }
      : {};
  return tx.inventoryProduct.create({
    data: {
      salonId,
      globalProductId,
      usage,
      name: catalog.name.slice(0, 120),
      normalizedName: catalog.name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .slice(0, 120),
      unit: 'EACH',
      ...content,
    },
    select,
  });
}

/** Pieces of a catalog product (as ordered/sold) in the salon product's own stock unit. */
export async function piecesToStock(
  tx: Tx,
  pieces: number,
  product: { unit: InventoryUnit },
  globalProductId: string | null,
): Promise<Prisma.Decimal> {
  if (['EACH', 'PACK', 'BOX'].includes(product.unit))
    return new Prisma.Decimal(pieces.toFixed(3));
  const catalog = globalProductId
    ? await tx.globalProduct.findUnique({
        where: { id: globalProductId },
        select: { packSize: true, packUnit: true },
      })
    : null;
  if (catalog?.packSize && catalog.packUnit) {
    const c = convertToStockUnit(
      pieces * Number(catalog.packSize),
      catalog.packUnit,
      { unit: product.unit },
    );
    if (c.ok) return new Prisma.Decimal(c.quantity.toFixed(3));
  }
  throw new AppException(
    InventoryErrorCode.INVALID_MOVEMENT,
    'This product is counted in a unit that pieces can’t be converted to. Count it in pieces, or set its pack size in the catalog.',
    HttpStatus.BAD_REQUEST,
  );
}

/** Next per-salon purchase order number (PO-0001), or a global order number (FQ-…). */
export async function nextPoNumber(tx: Tx, salonId: string): Promise<string> {
  const count = await tx.purchaseOrder.count({ where: { salonId } });
  return `PO-${String(count + 1).padStart(4, '0')}`;
}

export function orderNumber(): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, '0');
  return `FQ-${t}${r}`.slice(0, 20);
}
