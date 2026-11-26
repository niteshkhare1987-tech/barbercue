import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  Prisma,
  type CommerceBatch,
  type CommerceMovementKind,
} from '@prisma/client';
import type {
  CommerceStockAdjustInput,
  CommerceStockInInput,
} from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  TX_OPTIONS,
  conflict,
  dateOnly,
  fail,
  flag,
  indiaToday,
  notFound,
  type Db,
  type Tx,
} from './commerce-support';

interface Deltas {
  onHand?: number;
  reserved?: number;
  quarantined?: number;
  damaged?: number;
  expired?: number;
}
export interface Allocation {
  batchId: string;
  quantity: number;
  unitCost: Prisma.Decimal;
}

/**
 * FastQue's own stock. A batch row is the current position; commerce_stock_movements is the
 * append-only ledger (a database trigger rejects changes to it). Every change locks the batch rows
 * first and database CHECKs refuse a negative bucket or more reserved than on hand.
 *
 * Lifecycle: RESERVE (order placed) → DISPATCH (shipped, the units leave) or RELEASE (cancelled).
 * Units that come back always enter quarantine and are inspected before they can be sold again.
 */
@Injectable()
export class CommerceStockService {
  private readonly log = new Logger(CommerceStockService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Units that can be ordered now: on hand, unreserved, unexpired, in an active warehouse. */
  async available(
    db: Db,
    listingIds: string[],
    warehouseId?: string,
  ): Promise<Map<string, number>> {
    if (!listingIds.length) return new Map();
    const rows = await db.commerceBatch.groupBy({
      by: ['listingId'],
      where: {
        listingId: { in: listingIds },
        ...(warehouseId ? { warehouseId } : {}),
        warehouse: { isActive: true },
        OR: [{ expiresOn: null }, { expiresOn: { gt: indiaToday() } }],
      },
      _sum: { onHand: true, reserved: true },
    });
    return new Map(
      rows.map((r) => [
        r.listingId,
        Math.max(0, (r._sum.onHand ?? 0) - (r._sum.reserved ?? 0)),
      ]),
    );
  }

  private async lock(tx: Tx, ids: string[]): Promise<void> {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length)
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "commerce_batches" WHERE "id" IN (${Prisma.join(sorted.map((i) => Prisma.sql`${i}::uuid`))}) ORDER BY "id" FOR UPDATE`,
      );
  }

  /** The only writer of batch quantities. The caller holds the row lock. */
  private async move(
    tx: Tx,
    batchId: string,
    kind: CommerceMovementKind,
    d: Deltas,
    meta: {
      reference?: string;
      note?: string | null;
      actorUserId?: string | null;
      idempotencyKey?: string;
    },
  ): Promise<void> {
    await tx.commerceBatch.update({
      where: { id: batchId },
      data: {
        onHand: { increment: d.onHand ?? 0 },
        reserved: { increment: d.reserved ?? 0 },
        quarantined: { increment: d.quarantined ?? 0 },
        damaged: { increment: d.damaged ?? 0 },
        expired: { increment: d.expired ?? 0 },
      },
    });
    await tx.commerceStockMovement.create({
      data: {
        batchId,
        kind,
        onHandDelta: d.onHand ?? 0,
        reservedDelta: d.reserved ?? 0,
        quarantineDelta: d.quarantined ?? 0,
        damagedDelta: d.damaged ?? 0,
        expiredDelta: d.expired ?? 0,
        reference: meta.reference ?? null,
        note: meta.note ?? null,
        actorUserId: meta.actorUserId ?? null,
        idempotencyKey: meta.idempotencyKey ?? null,
      },
    });
  }

  /** Lock every sellable batch of these listings in one warehouse (fixed order → no deadlocks). */
  async lockListings(
    tx: Tx,
    listingIds: string[],
    warehouseId: string,
  ): Promise<void> {
    const rows = await tx.commerceBatch.findMany({
      where: { listingId: { in: listingIds }, warehouseId },
      select: { id: true },
    });
    await this.lock(
      tx,
      rows.map((r) => r.id),
    );
  }

  /** First-expiry-first-out reservation. Throws (and so rolls the order back) if stock is short. */
  async reserve(
    tx: Tx,
    listingId: string,
    warehouseId: string,
    quantity: number,
    reference: string,
    actorUserId: string | null,
  ): Promise<Allocation[]> {
    await this.lockListings(tx, [listingId], warehouseId);
    const batches = await tx.commerceBatch.findMany({
      where: {
        listingId,
        warehouseId,
        onHand: { gt: 0 },
        OR: [{ expiresOn: null }, { expiresOn: { gt: indiaToday() } }],
      },
      orderBy: [
        { expiresOn: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
    });
    const out: Allocation[] = [];
    let left = quantity;
    for (const b of batches) {
      const take = Math.min(left, b.onHand - b.reserved);
      if (take <= 0) continue;
      await this.move(
        tx,
        b.id,
        'RESERVE',
        { reserved: take },
        { reference, actorUserId },
      );
      out.push({ batchId: b.id, quantity: take, unitCost: b.unitCost });
      left -= take;
      if (!left) break;
    }
    if (left)
      throw conflict(
        'COMMERCE_OUT_OF_STOCK',
        'Not enough stock is available for this order.',
      );
    return out;
  }

  /** Cancelled before dispatch: the reservation ends, nothing physically moves. */
  async releaseOrder(
    tx: Tx,
    orderId: string,
    reference: string,
    actorUserId: string | null,
  ): Promise<void> {
    const rows = await tx.commerceAllocation.findMany({
      where: { state: 'RESERVED', orderItem: { orderId } },
    });
    await this.lock(
      tx,
      rows.map((r) => r.batchId),
    );
    for (const a of rows) {
      const claimed = await tx.commerceAllocation.updateMany({
        where: { id: a.id, state: 'RESERVED' },
        data: { state: 'RELEASED' },
      });
      if (claimed.count)
        await this.move(
          tx,
          a.batchId,
          'RELEASE',
          { reserved: -a.quantity },
          { reference, actorUserId },
        );
    }
  }

  /** The parcel physically leaves: reserved units come off stock exactly once. */
  async dispatchOrder(
    tx: Tx,
    orderId: string,
    reference: string,
    actorUserId: string | null,
  ): Promise<void> {
    const rows = await tx.commerceAllocation.findMany({
      where: { state: 'RESERVED', orderItem: { orderId } },
      include: {
        batch: { select: { expiresOn: true, batchNumber: true } },
      },
    });
    const bad = rows.find(
      (r) => r.batch.expiresOn && r.batch.expiresOn <= indiaToday(),
    );
    if (bad)
      throw conflict(
        'COMMERCE_BATCH_EXPIRED',
        `Batch ${bad.batch.batchNumber} has expired and cannot be shipped. Cancel the order or replace the units.`,
      );
    await this.lock(
      tx,
      rows.map((r) => r.batchId),
    );
    for (const a of rows) {
      const claimed = await tx.commerceAllocation.updateMany({
        where: { id: a.id, state: 'RESERVED' },
        data: { state: 'DISPATCHED' },
      });
      if (claimed.count)
        await this.move(
          tx,
          a.batchId,
          'DISPATCH',
          { onHand: -a.quantity, reserved: -a.quantity },
          { reference, actorUserId },
        );
    }
  }

  /** Units physically back from a customer or courier: quarantined, never sellable by themselves. */
  async quarantineReturned(
    tx: Tx,
    orderItemId: string,
    quantity: number,
    reference: string,
    actorUserId: string | null,
  ): Promise<void> {
    const rows = await tx.commerceAllocation.findMany({
      where: { orderItemId, state: 'DISPATCHED' },
      orderBy: { id: 'asc' },
    });
    await this.lock(
      tx,
      rows.map((r) => r.batchId),
    );
    let left = quantity;
    for (const a of rows) {
      const take = Math.min(left, a.quantity);
      if (!take) break;
      await this.move(
        tx,
        a.batchId,
        'QUARANTINE_IN',
        { quarantined: take },
        { reference, note: 'Returned units', actorUserId },
      );
      left -= take;
    }
    if (left)
      throw conflict(
        'COMMERCE_RETURN_QUANTITY',
        'More units were returned than were shipped.',
      );
  }

  /** Inspection result for units quarantined under `reference`. */
  async inspectReturned(
    tx: Tx,
    reference: string,
    disposition: 'RESTOCK' | 'DAMAGED',
    actorUserId: string,
  ): Promise<void> {
    const rows = await tx.commerceStockMovement.findMany({
      where: { reference, kind: 'QUARANTINE_IN' },
      include: { batch: { select: { expiresOn: true, batchNumber: true } } },
    });
    await this.lock(
      tx,
      rows.map((r) => r.batchId),
    );
    for (const m of rows) {
      if (
        disposition === 'RESTOCK' &&
        m.batch.expiresOn &&
        m.batch.expiresOn <= indiaToday()
      )
        throw conflict(
          'COMMERCE_BATCH_EXPIRED',
          `Batch ${m.batch.batchNumber} has expired; these units cannot be restocked.`,
        );
      const q = m.quarantineDelta;
      await this.move(
        tx,
        m.batchId,
        disposition === 'RESTOCK' ? 'QUARANTINE_OUT' : 'DAMAGE',
        disposition === 'RESTOCK'
          ? { quarantined: -q, onHand: q }
          : { quarantined: -q, damaged: q },
        {
          reference,
          note:
            disposition === 'RESTOCK'
              ? 'Inspected: unopened, back on sale'
              : 'Inspected: not sellable',
          actorUserId,
        },
      );
    }
  }

  /** Units going back to the supplier leave from one stock condition, through the ledger. */
  async leaveToSupplier(
    tx: Tx,
    batchId: string,
    source: 'ON_HAND' | 'DAMAGED' | 'QUARANTINED' | 'EXPIRED',
    quantity: number,
    reference: string,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.lock(tx, [batchId]);
    const b = await tx.commerceBatch.findUnique({ where: { id: batchId } });
    if (!b) throw notFound('The batch');
    const have =
      source === 'ON_HAND'
        ? b.onHand - b.reserved
        : source === 'DAMAGED'
          ? b.damaged
          : source === 'QUARANTINED'
            ? b.quarantined
            : b.expired;
    if (quantity > have)
      throw conflict(
        'COMMERCE_QUANTITY',
        `Only ${have} unit(s) can be returned from this batch.`,
      );
    await this.move(
      tx,
      batchId,
      'ADJUSTMENT',
      source === 'ON_HAND'
        ? { onHand: -quantity }
        : source === 'DAMAGED'
          ? { damaged: -quantity }
          : source === 'QUARANTINED'
            ? { quarantined: -quantity }
            : { expired: -quantity },
      { reference, note: 'Returned to supplier', actorUserId, idempotencyKey },
    );
  }

  async stockIn(
    tx: Tx,
    input: CommerceStockInInput,
    kind: 'OPENING' | 'PURCHASE',
    actorUserId: string,
    extra: {
      reference?: string;
      idempotencyKey?: string;
      supplierId?: string;
      purchaseOrderId?: string;
    } = {},
  ): Promise<CommerceBatch> {
    const listing = await tx.commerceListing.findUnique({
      where: { id: input.listingId },
    });
    if (!listing) throw notFound('The product');
    const warehouse = await tx.commerceWarehouse.findUnique({
      where: { id: input.warehouseId },
    });
    if (!warehouse?.isActive) throw notFound('The warehouse');
    const expiresOn = input.expiresOn ? dateOnly(input.expiresOn) : null;
    if (listing.expiryTracked && !expiresOn)
      throw fail(
        'COMMERCE_EXPIRY_REQUIRED',
        'This product is expiry-tracked; enter the expiry date.',
      );
    if (expiresOn && expiresOn <= indiaToday())
      throw fail('COMMERCE_BATCH_EXPIRED', 'Expired stock cannot be received.');
    const manufacturedOn = input.manufacturedOn
      ? dateOnly(input.manufacturedOn)
      : null;
    if (manufacturedOn && expiresOn && manufacturedOn >= expiresOn)
      throw fail(
        'COMMERCE_DATES',
        'The manufacturing date must be before the expiry date.',
      );
    const key = {
      listingId: input.listingId,
      warehouseId: input.warehouseId,
      batchNumber: input.batchNumber.trim(),
    };
    // createMany+skipDuplicates so two people receiving the same batch at once cannot collide.
    await tx.commerceBatch.createMany({
      data: [
        {
          ...key,
          manufacturedOn,
          expiresOn,
          unitCost: input.unitCost,
          storageLocation: input.storageLocation ?? null,
          supplierId: extra.supplierId ?? null,
          purchaseOrderId: extra.purchaseOrderId ?? null,
        },
      ],
      skipDuplicates: true,
    });
    let batch = await tx.commerceBatch.findUniqueOrThrow({
      where: { listingId_warehouseId_batchNumber: key },
    });
    await this.lock(tx, [batch.id]);
    if ((batch.expiresOn?.getTime() ?? null) !== (expiresOn?.getTime() ?? null))
      throw conflict(
        'COMMERCE_BATCH_MISMATCH',
        'This batch number already exists with a different expiry date.',
      );
    batch = await tx.commerceBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    const before = batch.onHand + batch.quarantined;
    const cost = new Prisma.Decimal(input.unitCost);
    if (before > 0 && !batch.unitCost.equals(cost))
      await tx.commerceBatch.update({
        where: { id: batch.id },
        data: {
          unitCost: batch.unitCost
            .mul(before)
            .add(cost.mul(input.quantity))
            .div(before + input.quantity)
            .toDecimalPlaces(2),
        },
      });
    await this.move(
      tx,
      batch.id,
      kind,
      { onHand: input.quantity },
      {
        reference: extra.reference,
        note: input.note,
        actorUserId,
        idempotencyKey: extra.idempotencyKey,
      },
    );
    return tx.commerceBatch.findUniqueOrThrow({ where: { id: batch.id } });
  }

  async adjust(
    batchId: string,
    input: CommerceStockAdjustInput,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<CommerceBatch> {
    if (input.kind !== 'ADJUSTMENT' && input.quantity < 0)
      throw fail('COMMERCE_QUANTITY', 'Enter a quantity above 0.');
    return this.prisma.$transaction(async (tx) => {
      const done = await tx.commerceStockMovement.findUnique({
        where: { idempotencyKey },
      });
      if (done) {
        if (done.batchId !== batchId)
          throw conflict(
            'COMMERCE_IDEMPOTENCY_CONFLICT',
            'This request key was already used.',
          );
        return tx.commerceBatch.findUniqueOrThrow({ where: { id: batchId } });
      }
      await this.lock(tx, [batchId]);
      const b = await tx.commerceBatch.findUnique({ where: { id: batchId } });
      if (!b) throw notFound('The batch');
      const q = input.quantity;
      const free = b.onHand - b.reserved;
      const d: Deltas =
        input.kind === 'ADJUSTMENT'
          ? { onHand: q }
          : input.kind === 'DAMAGE'
            ? { onHand: -q, damaged: q }
            : input.kind === 'EXPIRE'
              ? { onHand: -q, expired: q }
              : input.kind === 'QUARANTINE_IN'
                ? { onHand: -q, quarantined: q }
                : { quarantined: -q, onHand: q };
      if ((d.onHand ?? 0) < 0 && -d.onHand! > free)
        throw conflict(
          'COMMERCE_STOCK_RESERVED',
          `Only ${free} unreserved unit(s) can be moved from this batch.`,
        );
      if (input.kind === 'QUARANTINE_OUT' && q > b.quarantined)
        throw conflict(
          'COMMERCE_QUANTITY',
          `Only ${b.quarantined} unit(s) are in quarantine.`,
        );
      if ((d.onHand ?? 0) > 0 && b.expiresOn && b.expiresOn <= indiaToday())
        throw conflict(
          'COMMERCE_BATCH_EXPIRED',
          'This batch has expired; units cannot be put on sale.',
        );
      await this.move(tx, batchId, input.kind, d, {
        note: input.note,
        actorUserId,
        idempotencyKey,
      });
      await tx.auditLog.create({
        data: {
          actorUserId,
          action: `COMMERCE_STOCK_${input.kind}`,
          entityType: 'CommerceBatch',
          entityId: batchId,
          metadata: { quantity: q, note: input.note },
        },
      });
      return tx.commerceBatch.findUniqueOrThrow({ where: { id: batchId } });
    }, TX_OPTIONS);
  }

  async transfer(
    batchId: string,
    toWarehouseId: string,
    quantity: number,
    note: string | null,
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (
        await tx.commerceStockMovement.findUnique({
          where: { idempotencyKey },
        })
      )
        return;
      const from = await tx.commerceBatch.findUnique({
        where: { id: batchId },
      });
      if (!from) throw notFound('The batch');
      const to = await tx.commerceWarehouse.findUnique({
        where: { id: toWarehouseId },
      });
      if (!to?.isActive || to.id === from.warehouseId)
        throw fail('COMMERCE_WAREHOUSE', 'Choose another active warehouse.');
      const key = {
        listingId: from.listingId,
        warehouseId: to.id,
        batchNumber: from.batchNumber,
      };
      await tx.commerceBatch.createMany({
        data: [
          {
            ...key,
            manufacturedOn: from.manufacturedOn,
            expiresOn: from.expiresOn,
            unitCost: from.unitCost,
            supplierId: from.supplierId,
            purchaseOrderId: from.purchaseOrderId,
          },
        ],
        skipDuplicates: true,
      });
      const dest = await tx.commerceBatch.findUniqueOrThrow({
        where: { listingId_warehouseId_batchNumber: key },
      });
      await this.lock(tx, [from.id, dest.id]);
      const fresh = await tx.commerceBatch.findUniqueOrThrow({
        where: { id: from.id },
      });
      if (
        (dest.expiresOn?.getTime() ?? null) !==
        (fresh.expiresOn?.getTime() ?? null)
      )
        throw conflict(
          'COMMERCE_BATCH_MISMATCH',
          'The other warehouse has this batch with a different expiry date.',
        );
      if (quantity > fresh.onHand - fresh.reserved)
        throw conflict(
          'COMMERCE_STOCK_RESERVED',
          `Only ${fresh.onHand - fresh.reserved} unreserved unit(s) can be transferred.`,
        );
      const reference = `TRF-${idempotencyKey.slice(-20)}`;
      await this.move(
        tx,
        from.id,
        'TRANSFER_OUT',
        { onHand: -quantity },
        { reference, note, actorUserId, idempotencyKey },
      );
      await this.move(
        tx,
        dest.id,
        'TRANSFER_IN',
        { onHand: quantity },
        { reference, note, actorUserId },
      );
    }, TX_OPTIONS);
  }

  /** Once a day, unreserved expired units leave sellable stock through the ledger. */
  @Cron('20 19 * * *')
  async expireBatches(): Promise<number> {
    if (!flag('FASTQUE_DIRECT_COMMERCE_ENABLED')) return 0;
    const due = await this.prisma.commerceBatch.findMany({
      where: { onHand: { gt: 0 }, expiresOn: { lte: indiaToday() } },
      select: { id: true },
      take: 1000,
    });
    let moved = 0;
    for (const { id } of due) {
      try {
        moved += await this.prisma.$transaction(async (tx) => {
          await this.lock(tx, [id]);
          const b = await tx.commerceBatch.findUniqueOrThrow({
            where: { id },
          });
          const q = b.onHand - b.reserved;
          if (q <= 0) return 0;
          await this.move(
            tx,
            id,
            'EXPIRE',
            { onHand: -q, expired: q },
            { note: 'Expired (automatic)' },
          );
          return q;
        }, TX_OPTIONS);
      } catch (error) {
        this.log.warn(
          `Could not expire batch ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return moved;
  }
}
