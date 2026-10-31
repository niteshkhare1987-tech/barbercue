import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  INVENTORY_LOSS_KINDS,
  InventoryMovementKind as MovementKind,
  InventoryErrorCode,
  normalizeBarcode,
} from '@barbercue/shared';
import { Prisma, type InventoryMovementKind } from '@prisma/client';
import {
  type CreateInventoryCategoryInput,
  type CreateInventoryMovementInput,
  type CreateInventoryProductInput,
  type CreateInventorySupplierInput,
  type InventoryCategoryDto,
  type InventoryProductListQuery,
  type InventoryMovementListQuery,
  type InventoryMovementDto,
  type InventoryLookupListQuery,
  type InventoryPageDto,
  type InventoryProductDto,
  type InventoryReportDto,
  type InventorySupplierDto,
  type UpdateInventoryProductInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { PrismaService } from '../prisma/prisma.service';

const productRelations = {
  category: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  // Inventory Phase 1: the linked Global Product Master entry's barcode, first photo and brand.
  globalProduct: {
    select: {
      brand: true,
      barcodes: {
        select: { display: true },
        orderBy: { createdAt: 'asc' as const },
        take: 1,
      },
      images: {
        select: { url: true },
        orderBy: { sortOrder: 'asc' as const },
        take: 1,
      },
    },
  },
} satisfies Prisma.InventoryProductInclude;
type ProductRecord = Prisma.InventoryProductGetPayload<{
  include: typeof productRelations;
}>;

const movementRelations = {
  product: { select: { id: true, name: true, sku: true } },
  supplier: { select: { id: true, name: true } },
} satisfies Prisma.InventoryMovementInclude;
type MovementRecord = Prisma.InventoryMovementGetPayload<{
  include: typeof movementRelations;
}>;

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
  ) {}

  async listCategories(
    userId: string,
    salonId: string,
    query: InventoryLookupListQuery,
  ): Promise<InventoryPageDto<InventoryCategoryDto>> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const filterHash = this.cursorFilterHash({
      resource: 'categories',
      salonId,
    });
    const afterId = query.cursor
      ? this.decodeCursor(query.cursor, filterHash)
      : null;
    const rows = await this.prisma.inventoryCategory.findMany({
      where: { salonId, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: [{ id: 'asc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map((row) => ({
      id: row.id,
      salonId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && items.length > 0
          ? this.encodeCursor(items[items.length - 1].id, filterHash)
          : null,
    };
  }

  async createCategory(
    userId: string,
    salonId: string,
    input: CreateInventoryCategoryInput,
  ): Promise<InventoryCategoryDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const trimmed = input.name.trim();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const category = await tx.inventoryCategory.create({
          data: {
            salonId,
            name: trimmed,
            normalizedName: this.normalizeName(trimmed),
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVENTORY_CATEGORY_CREATED',
            entityType: 'InventoryCategory',
            entityId: category.id,
            metadata: { salonId },
          },
        });
        return category;
      });
      return {
        id: row.id,
        salonId,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.conflict(
          InventoryErrorCode.CATEGORY_EXISTS,
          'An inventory category with this name already exists.',
        );
      }
      throw error;
    }
  }

  async listSuppliers(
    userId: string,
    salonId: string,
    query: InventoryLookupListQuery,
  ): Promise<InventoryPageDto<InventorySupplierDto>> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const filterHash = this.cursorFilterHash({
      resource: 'suppliers',
      salonId,
    });
    const afterId = query.cursor
      ? this.decodeCursor(query.cursor, filterHash)
      : null;
    const rows = await this.prisma.inventorySupplier.findMany({
      where: { salonId, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: [{ id: 'asc' }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const items = rows
      .slice(0, query.limit)
      .map((row) => this.toSupplierDto(row));
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && items.length > 0
          ? this.encodeCursor(items[items.length - 1].id, filterHash)
          : null,
    };
  }

  async createSupplier(
    userId: string,
    salonId: string,
    input: CreateInventorySupplierInput,
  ): Promise<InventorySupplierDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const trimmed = input.name.trim();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const supplier = await tx.inventorySupplier.create({
          data: {
            salonId,
            name: trimmed,
            normalizedName: this.normalizeName(trimmed),
            contactName: this.nullableTrim(input.contactName),
            phone: this.nullableTrim(input.phone),
            email: this.nullableTrim(input.email)?.toLowerCase() ?? null,
            notes: this.nullableTrim(input.notes),
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVENTORY_SUPPLIER_CREATED',
            entityType: 'InventorySupplier',
            entityId: supplier.id,
            metadata: { salonId },
          },
        });
        return supplier;
      });
      return this.toSupplierDto(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.conflict(
          InventoryErrorCode.SUPPLIER_EXISTS,
          'A supplier with this name already exists.',
        );
      }
      throw error;
    }
  }

  async listProducts(
    userId: string,
    salonId: string,
    query: InventoryProductListQuery,
  ): Promise<InventoryPageDto<InventoryProductDto>> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const filterHash = this.cursorFilterHash({
      resource: 'products',
      salonId,
      q: query.q ?? null,
      categoryId: query.categoryId ?? null,
      lowStock: query.lowStock ?? false,
    });
    const afterId = query.cursor
      ? this.decodeCursor(query.cursor, filterHash)
      : null;
    const where: Prisma.InventoryProductWhereInput = {
      salonId,
      ...(afterId ? { id: { gt: afterId } } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { sku: { contains: query.q, mode: 'insensitive' } },
              ...(() => {
                const barcode = normalizeBarcode(query.q);
                return barcode.ok
                  ? [
                      {
                        globalProduct: {
                          barcodes: { some: { code: barcode.code } },
                        },
                      },
                    ]
                  : [];
              })(),
            ],
          }
        : {}),
    };

    let rows: ProductRecord[];
    let hasMore: boolean;
    if (query.lowStock) {
      const predicates: Prisma.Sql[] = [
        Prisma.sql`"salonId" = ${salonId}`,
        Prisma.sql`"isActive" = true`,
        Prisma.sql`"stockOnHand" <= "reorderThreshold"`,
      ];
      if (afterId) predicates.push(Prisma.sql`"id" > ${afterId}`);
      if (query.categoryId)
        predicates.push(Prisma.sql`"categoryId" = ${query.categoryId}`);
      if (query.q)
        predicates.push(
          Prisma.sql`("name" ILIKE ${`%${query.q}%`} OR COALESCE("sku", '') ILIKE ${`%${query.q}%`})`,
        );
      const ids = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "inventory_products" WHERE ${Prisma.join(predicates, ' AND ')}
        ORDER BY "id" ASC LIMIT ${query.limit + 1}
      `);
      hasMore = ids.length > query.limit;
      const pageIds = ids.slice(0, query.limit).map(({ id }) => id);
      rows =
        pageIds.length === 0
          ? []
          : await this.prisma.inventoryProduct.findMany({
              where: { ...where, id: { in: pageIds } },
              include: productRelations,
              orderBy: [{ id: 'asc' }],
            });
    } else {
      const pageRows = await this.prisma.inventoryProduct.findMany({
        where,
        include: productRelations,
        orderBy: [{ id: 'asc' }],
        take: query.limit + 1,
      });
      hasMore = pageRows.length > query.limit;
      rows = pageRows.slice(0, query.limit);
    }
    return {
      items: rows.map((row) => this.toProductDto(row)),
      hasMore,
      nextCursor:
        hasMore && rows.length > 0
          ? this.encodeCursor(rows[rows.length - 1].id, filterHash)
          : null,
    };
  }

  async createProduct(
    userId: string,
    salonId: string,
    input: CreateInventoryProductInput,
  ): Promise<InventoryProductDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    await this.assertReferences(salonId, input.categoryId, input.supplierId);
    const trimmed = input.name.trim();
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const product = await tx.inventoryProduct.create({
          data: {
            salonId,
            name: trimmed,
            normalizedName: this.normalizeName(trimmed),
            sku: input.sku?.trim().toUpperCase() || null,
            unit: input.unit,
            categoryId: input.categoryId ?? null,
            supplierId: input.supplierId ?? null,
            isActive: input.isActive ?? true,
            reorderThreshold: input.reorderThreshold.toFixed(3),
            sellingPrice: input.sellingPrice?.toFixed(2) ?? null,
            storageLocation: this.nullableTrim(input.storageLocation),
            minimumOrderQuantity:
              input.minimumOrderQuantity?.toFixed(3) ?? null,
          },
          include: productRelations,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVENTORY_PRODUCT_CREATED',
            entityType: 'InventoryProduct',
            entityId: product.id,
            metadata: { salonId, unit: product.unit },
          },
        });
        return product;
      });
      return this.toProductDto(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.conflict(
          InventoryErrorCode.PRODUCT_EXISTS,
          'An inventory product with this SKU already exists.',
        );
      }
      throw error;
    }
  }

  async updateProduct(
    userId: string,
    salonId: string,
    productId: string,
    input: UpdateInventoryProductInput,
  ): Promise<InventoryProductDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const existing = await this.prisma.inventoryProduct.findFirst({
      where: { id: productId, salonId },
    });
    if (!existing)
      throw this.notFound(
        InventoryErrorCode.PRODUCT_NOT_FOUND,
        'Inventory product not found.',
      );
    await this.assertReferences(salonId, input.categoryId, input.supplierId);
    const data: Prisma.InventoryProductUpdateInput = {
      ...(input.name !== undefined
        ? {
            name: input.name.trim(),
            normalizedName: this.normalizeName(input.name),
          }
        : {}),
      ...(input.sku !== undefined
        ? { sku: input.sku?.trim().toUpperCase() || null }
        : {}),
      ...(input.unit !== undefined ? { unit: input.unit } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.categoryId !== undefined
        ? {
            category: input.categoryId
              ? { connect: { id_salonId: { id: input.categoryId, salonId } } }
              : { disconnect: true },
          }
        : {}),
      ...(input.supplierId !== undefined
        ? {
            supplier: input.supplierId
              ? { connect: { id_salonId: { id: input.supplierId, salonId } } }
              : { disconnect: true },
          }
        : {}),
      ...(input.reorderThreshold !== undefined
        ? { reorderThreshold: input.reorderThreshold.toFixed(3) }
        : {}),
      ...(input.sellingPrice !== undefined
        ? { sellingPrice: input.sellingPrice?.toFixed(2) ?? null }
        : {}),
      ...(input.storageLocation !== undefined
        ? { storageLocation: this.nullableTrim(input.storageLocation) }
        : {}),
      ...(input.minimumOrderQuantity !== undefined
        ? {
            minimumOrderQuantity:
              input.minimumOrderQuantity?.toFixed(3) ?? null,
          }
        : {}),
    };
    if (input.categoryId !== undefined && input.categoryId === null)
      data.category = { disconnect: true };
    if (input.supplierId !== undefined && input.supplierId === null)
      data.supplier = { disconnect: true };
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const product = await tx.inventoryProduct.update({
          where: { id: productId },
          data,
          include: productRelations,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'INVENTORY_PRODUCT_UPDATED',
            entityType: 'InventoryProduct',
            entityId: productId,
            metadata: { salonId, changedFields: Object.keys(input) },
          },
        });
        return product;
      });
      return this.toProductDto(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw this.conflict(
          InventoryErrorCode.PRODUCT_EXISTS,
          'An inventory product with this SKU already exists.',
        );
      }
      throw error;
    }
  }

  async createMovement(
    userId: string,
    salonId: string,
    productId: string,
    idempotencyKey: string | undefined,
    input: CreateInventoryMovementInput,
  ): Promise<{ movement: InventoryMovementDto; created: boolean }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const key = this.validateIdempotencyKey(idempotencyKey);
    if (input.supplierId)
      await this.assertReferences(salonId, undefined, input.supplierId);

    const quantityDelta =
      input.kind === MovementKind.CONSUMPTION ||
      (INVENTORY_LOSS_KINDS as readonly string[]).includes(input.kind)
        ? -input.quantity
        : input.kind === MovementKind.ADJUSTMENT &&
            input.adjustmentDirection === 'DECREASE'
          ? -input.quantity
          : input.quantity;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          userId,
          salonId,
          productId,
          kind: input.kind,
          quantityDelta: quantityDelta.toFixed(3),
          unitCost: input.unitCost?.toFixed(2) ?? null,
          supplierId: input.supplierId ?? null,
          reason: input.reason?.trim() ?? null,
          reference: input.reference?.trim() ?? null,
          batchNumber: input.batchNumber?.trim() || null,
          expiryDate: input.expiryDate ?? null,
        }),
      )
      .digest('hex');

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<
            Array<{ id: string; stockOnHand: Prisma.Decimal }>
          >(Prisma.sql`
          SELECT "id", "stockOnHand" FROM "inventory_products"
          WHERE "id" = ${productId} AND "salonId" = ${salonId} FOR UPDATE
        `);
          if (locked.length === 0)
            throw this.notFound(
              InventoryErrorCode.PRODUCT_NOT_FOUND,
              'Inventory product not found.',
            );

          const existing = await tx.inventoryMovement.findUnique({
            where: { salonId_idempotencyKey: { salonId, idempotencyKey: key } },
            include: movementRelations,
          });
          if (existing) {
            if (
              existing.actorUserId !== userId ||
              existing.requestHash !== requestHash
            ) {
              throw this.conflict(
                InventoryErrorCode.IDEMPOTENCY_KEY_REUSED,
                'This idempotency key was already used for a different inventory movement.',
              );
            }
            return { movement: existing, created: false };
          }

          const delta = new Prisma.Decimal(quantityDelta.toFixed(3));
          if (locked[0].stockOnHand.plus(delta).lessThan(0)) {
            throw this.conflict(
              InventoryErrorCode.INSUFFICIENT_STOCK,
              'This movement would reduce stock below zero.',
            );
          }
          if (input.kind === MovementKind.OPENING) {
            const prior = await tx.inventoryMovement.count({
              where: { productId },
            });
            if (prior > 0 || !locked[0].stockOnHand.isZero()) {
              throw this.conflict(
                InventoryErrorCode.OPENING_ALREADY_RECORDED,
                'Opening stock can only be recorded before any other movement.',
              );
            }
          }

          const movement = await tx.inventoryMovement.create({
            data: {
              salonId,
              productId,
              supplierId:
                input.kind === MovementKind.PURCHASE ||
                input.kind === MovementKind.RETURN
                  ? (input.supplierId ?? null)
                  : null,
              actorUserId: userId,
              kind: input.kind,
              quantityDelta: delta,
              unitCost:
                input.unitCost === undefined
                  ? null
                  : new Prisma.Decimal(input.unitCost.toFixed(2)),
              reason: input.reason?.trim() || null,
              reference: input.reference?.trim() || null,
              batchNumber: input.batchNumber?.trim() || null,
              expiryDate: input.expiryDate
                ? new Date(`${input.expiryDate}T00:00:00.000Z`)
                : null,
              idempotencyKey: key,
              requestHash,
            },
            include: movementRelations,
          });
          await tx.auditLog.create({
            data: {
              actorUserId: userId,
              action: 'INVENTORY_MOVEMENT_RECORDED',
              entityType: 'InventoryMovement',
              entityId: movement.id,
              metadata: {
                salonId,
                productId,
                kind: input.kind,
                quantityDelta: delta.toFixed(3),
                stockAfter: movement.stockAfter.toFixed(3),
              },
            },
          });
          return { movement, created: true };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 10000,
        },
      );
      return {
        movement: this.toMovementDto(result.movement),
        created: result.created,
      };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.prisma.inventoryMovement.findUnique({
          where: { salonId_idempotencyKey: { salonId, idempotencyKey: key } },
          include: movementRelations,
        });
        if (
          existing?.actorUserId === userId &&
          existing.requestHash === requestHash
        ) {
          return { movement: this.toMovementDto(existing), created: false };
        }
        throw this.conflict(
          InventoryErrorCode.IDEMPOTENCY_KEY_REUSED,
          'This idempotency key was already used for a different inventory movement.',
        );
      }
      throw error;
    }
  }

  /** One product as a DTO, for callers that already checked access (e.g. ProductCatalogService). */
  async getProduct(
    salonId: string,
    productId: string,
  ): Promise<InventoryProductDto> {
    const row = await this.prisma.inventoryProduct.findFirst({
      where: { id: productId, salonId },
      include: productRelations,
    });
    if (!row)
      throw this.notFound(
        InventoryErrorCode.PRODUCT_NOT_FOUND,
        'Inventory product not found.',
      );
    return this.toProductDto(row);
  }

  async listMovements(
    userId: string,
    salonId: string,
    query: InventoryMovementListQuery,
  ): Promise<InventoryPageDto<InventoryMovementDto>> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const filterHash = this.cursorFilterHash({
      resource: 'movements',
      salonId,
      q: query.q ?? null,
      productId: query.productId ?? null,
      kind: query.kind ?? null,
    });
    const cursorId = query.cursor
      ? this.decodeCursor(query.cursor, filterHash)
      : null;
    const where: Prisma.InventoryMovementWhereInput = {
      salonId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q
        ? {
            OR: [
              {
                product: {
                  is: { name: { contains: query.q, mode: 'insensitive' } },
                },
              },
              {
                product: {
                  is: { sku: { contains: query.q, mode: 'insensitive' } },
                },
              },
              { reference: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const pageRows = await this.prisma.inventoryMovement.findMany({
      where,
      include: movementRelations,
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    const hasMore = pageRows.length > query.limit;
    const rows = pageRows.slice(0, query.limit);
    return {
      items: rows.map((row) => this.toMovementDto(row)),
      hasMore,
      nextCursor:
        hasMore && rows.length > 0
          ? this.encodeCursor(rows[rows.length - 1].id, filterHash)
          : null,
    };
  }

  async report(userId: string, salonId: string): Promise<InventoryReportDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const [summary, movementGroups, lowStockIds, salon] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          productCount: bigint;
          lowStockCount: bigint;
          estimatedStockValue: Prisma.Decimal;
        }>
      >(Prisma.sql`
        SELECT COUNT(*)::bigint AS "productCount",
          COUNT(*) FILTER (WHERE "isActive" = true AND "stockOnHand" <= "reorderThreshold")::bigint AS "lowStockCount",
          COALESCE(SUM("stockOnHand" * "averageUnitCost"), 0)::decimal(20,2) AS "estimatedStockValue"
        FROM "inventory_products" WHERE "salonId" = ${salonId}
      `),
      this.prisma.inventoryMovement.groupBy({
        by: ['kind'],
        where: { salonId },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "inventory_products"
        WHERE "salonId" = ${salonId} AND "isActive" = true AND "stockOnHand" <= "reorderThreshold"
        ORDER BY "stockOnHand" ASC, "normalizedName" ASC, "id" ASC LIMIT 100
      `),
      this.prisma.salon.findUnique({
        where: { id: salonId },
        select: { currency: true },
      }),
    ]);
    const lowStock = lowStockIds.length
      ? await this.prisma.inventoryProduct.findMany({
          where: { salonId, id: { in: lowStockIds.map(({ id }) => id) } },
          include: productRelations,
          orderBy: [
            { stockOnHand: 'asc' },
            { normalizedName: 'asc' },
            { id: 'asc' },
          ],
        })
      : [];
    const movementCounts: Record<InventoryMovementKind, number> = {
      OPENING: 0,
      PURCHASE: 0,
      CONSUMPTION: 0,
      ADJUSTMENT: 0,
      RETURN: 0,
      DAMAGE: 0,
      EXPIRY: 0,
      WASTAGE: 0,
      TRANSFER_OUT: 0,
      TRANSFER_IN: 0,
    };
    for (const group of movementGroups)
      movementCounts[group.kind] = group._count._all;
    const totals = summary[0] ?? {
      productCount: 0n,
      lowStockCount: 0n,
      estimatedStockValue: new Prisma.Decimal(0),
    };
    return {
      productCount: Number(totals.productCount),
      lowStockCount: Number(totals.lowStockCount),
      estimatedStockValue: totals.estimatedStockValue.toFixed(2),
      valuationBasis: 'weighted-average-cost',
      currency: salon?.currency ?? null,
      movementCounts,
      lowStockProducts: lowStock.map((product) => this.toProductDto(product)),
    };
  }

  private async assertReferences(
    salonId: string,
    categoryId?: string | null,
    supplierId?: string | null,
  ): Promise<void> {
    if (categoryId) {
      const category = await this.prisma.inventoryCategory.findFirst({
        where: { id: categoryId, salonId },
        select: { id: true },
      });
      if (!category)
        throw this.notFound(
          InventoryErrorCode.CATEGORY_NOT_FOUND,
          'Inventory category not found.',
        );
    }
    if (supplierId) {
      const supplier = await this.prisma.inventorySupplier.findFirst({
        where: { id: supplierId, salonId },
        select: { id: true },
      });
      if (!supplier)
        throw this.notFound(
          InventoryErrorCode.SUPPLIER_NOT_FOUND,
          'Inventory supplier not found.',
        );
    }
  }

  private validateIdempotencyKey(key: string | undefined): string {
    const normalized = key?.trim();
    if (
      !normalized ||
      normalized.length < 8 ||
      normalized.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(normalized)
    ) {
      throw new AppException(
        InventoryErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'A valid Idempotency-Key header is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return normalized;
  }

  private cursorFilterHash(filters: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
  }

  private encodeCursor(id: string, filterHash: string): string {
    const payload = Buffer.from(
      JSON.stringify({ version: 1, id, filterHash }),
    ).toString('base64url');
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret || secret.length < 32) {
      throw new AppException(
        'INVENTORY_CURSOR_UNAVAILABLE',
        'Inventory pagination is temporarily unavailable.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const signature = createHmac('sha256', secret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeCursor(cursor: string, expectedFilterHash: string): string {
    const [payload, suppliedSignature, extra] = cursor.split('.');
    const secret = process.env.JWT_ACCESS_SECRET;
    if (
      !payload ||
      !suppliedSignature ||
      extra !== undefined ||
      !secret ||
      secret.length < 32
    ) {
      throw this.cursorMismatch();
    }
    const expectedSignature = createHmac('sha256', secret)
      .update(payload)
      .digest();
    let receivedSignature: Buffer;
    try {
      receivedSignature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
      throw this.cursorMismatch();
    }
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw this.cursorMismatch();
    }
    try {
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { version?: number; id?: string; filterHash?: string };
      if (
        decoded.version !== 1 ||
        decoded.filterHash !== expectedFilterHash ||
        !decoded.id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          decoded.id,
        )
      ) {
        throw this.cursorMismatch();
      }
      return decoded.id;
    } catch {
      throw this.cursorMismatch();
    }
  }

  private cursorMismatch(): AppException {
    return new AppException(
      InventoryErrorCode.CURSOR_FILTER_MISMATCH,
      'This inventory cursor is invalid or belongs to different filters.',
      HttpStatus.BAD_REQUEST,
    );
  }

  private normalizeName(value: string): string {
    return value.trim().toLocaleLowerCase('en-US');
  }
  private nullableTrim(value: string | null | undefined): string | null {
    return value?.trim() || null;
  }

  private toSupplierDto(row: {
    id: string;
    salonId: string;
    name: string;
    contactName: string | null;
    phone: string | null;
    email: string | null;
    notes: string | null;
    createdAt: Date;
  }): InventorySupplierDto {
    return {
      id: row.id,
      salonId: row.salonId,
      name: row.name,
      contactName: row.contactName,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toProductDto(row: ProductRecord): InventoryProductDto {
    return {
      id: row.id,
      salonId: row.salonId,
      name: row.name,
      sku: row.sku,
      unit: row.unit,
      stockOnHand: row.stockOnHand.toFixed(3),
      averageUnitCost: row.averageUnitCost.toFixed(2),
      reorderThreshold: row.reorderThreshold.toFixed(3),
      isLowStock:
        row.isActive && row.stockOnHand.lessThanOrEqualTo(row.reorderThreshold),
      isActive: row.isActive,
      category: row.category
        ? { id: row.category.id, name: row.category.name }
        : null,
      supplier: row.supplier
        ? { id: row.supplier.id, name: row.supplier.name }
        : null,
      updatedAt: row.updatedAt.toISOString(),
      globalProductId: row.globalProductId,
      usage: row.usage,
      barcode: row.globalProduct?.barcodes[0]?.display ?? null,
      imageUrl: row.globalProduct?.images[0]?.url ?? null,
      brand: row.globalProduct?.brand ?? null,
      sellingPrice: row.sellingPrice?.toFixed(2) ?? null,
      storageLocation: row.storageLocation,
      minimumOrderQuantity: row.minimumOrderQuantity?.toFixed(3) ?? null,
    };
  }

  private toMovementDto(row: MovementRecord): InventoryMovementDto {
    return {
      id: row.id,
      salonId: row.salonId,
      productId: row.productId,
      productName: row.product.name,
      sku: row.product.sku,
      kind: row.kind,
      quantityDelta: row.quantityDelta.toFixed(3),
      unitCost: row.unitCost?.toFixed(2) ?? null,
      stockAfter: row.stockAfter.toFixed(3),
      averageUnitCostAfter: row.averageUnitCostAfter.toFixed(2),
      supplier: row.supplier
        ? { id: row.supplier.id, name: row.supplier.name }
        : null,
      actorUserId: row.actorUserId,
      reason: row.reason,
      reference: row.reference,
      recordedAt: row.recordedAt.toISOString(),
      batchNumber: row.batchNumber,
      expiryDate: row.expiryDate?.toISOString().slice(0, 10) ?? null,
    };
  }

  private notFound(code: string, message: string): AppException {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }
  private conflict(code: string, message: string): AppException {
    return new AppException(code, message, HttpStatus.CONFLICT);
  }
  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }
}
