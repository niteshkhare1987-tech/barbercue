import { createHash, randomUUID } from 'crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CatalogErrorCode,
  InventoryErrorCode,
  InventoryMovementKind as MovementKind,
  normalizeBarcode,
  ProductDataSource,
  ProductVerificationStatus,
  type CatalogLookupQuery,
  type CatalogLookupResultDto,
  type CatalogProductDto,
  type InventoryMovementDto,
  type InventoryProductDto,
  type ReceiveCatalogStockInput,
  type SubmitCatalogProductInput,
  type TransferStockInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';
import { OpenBeautyFactsClient } from './open-beauty-facts.client';

export const catalogProductInclude = {
  barcodes: { orderBy: { createdAt: 'asc' as const } },
  images: { orderBy: { sortOrder: 'asc' as const } },
} satisfies Prisma.GlobalProductInclude;
export type CatalogProductRecord = Prisma.GlobalProductGetPayload<{
  include: typeof catalogProductInclude;
}>;

export function toCatalogProductDto(
  row: CatalogProductRecord,
): CatalogProductDto {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    manufacturer: row.manufacturer,
    category: row.category,
    subcategory: row.subcategory,
    description: row.description,
    packSize: row.packSize?.toFixed(3) ?? null,
    packUnit: row.packUnit,
    mrp: row.mrp?.toFixed(2) ?? null,
    currency: row.currency,
    hsnCode: row.hsnCode,
    gstRatePercent: row.gstRatePercent?.toFixed(2) ?? null,
    productType: row.productType,
    dataSource: row.dataSource,
    sourceReference: row.sourceReference,
    sourceLicense: row.sourceLicense,
    verificationStatus: row.verificationStatus,
    barcodes: row.barcodes.map((b) => ({
      code: b.code,
      display: b.display,
      format: b.format,
    })),
    imageUrls: row.images.map((i) => i.url),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const normalizeProductName = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Salon side of the Global Product Master (Inventory Phase 1): look a scanned barcode up, submit a
 * product the scan didn't find, receive stock of a catalog product, and move stock between the
 * professional and retail shelves. Every stock change goes through the existing inventory ledger
 * (InventoryService.createMovement / the database movement trigger) — never a direct stock write.
 */
@Injectable()
export class ProductCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly inventory: InventoryService,
    private readonly openBeautyFacts: OpenBeautyFactsClient,
  ) {}

  async lookup(
    userId: string,
    salonId: string,
    query: CatalogLookupQuery,
  ): Promise<CatalogLookupResultDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const barcode = normalizeBarcode(query.barcode, query.hint);
    if (!barcode.ok)
      throw new AppException(
        CatalogErrorCode.INVALID_BARCODE,
        barcode.reason,
        HttpStatus.BAD_REQUEST,
      );
    const base: Omit<CatalogLookupResultDto, 'status'> = {
      barcode: {
        code: barcode.code,
        display: barcode.display,
        format: barcode.format,
      },
      pendingProductId: null,
      product: null,
      suggestion: null,
      salonStock: [],
    };

    const row = await this.prisma.globalProductBarcode.findUnique({
      where: { code: barcode.code },
      include: { product: { include: catalogProductInclude } },
    });
    const product = row?.product;
    if (
      product &&
      product.verificationStatus !== ProductVerificationStatus.REJECTED
    ) {
      const salonStock = (
        await this.prisma.inventoryProduct.findMany({
          where: { salonId, globalProductId: product.id },
          select: { id: true, usage: true, stockOnHand: true, unit: true },
          orderBy: { usage: 'asc' },
        })
      ).map((p) => ({
        inventoryProductId: p.id,
        usage: p.usage,
        stockOnHand: p.stockOnHand.toFixed(3),
        unit: p.unit,
      }));
      if (product.verificationStatus === ProductVerificationStatus.VERIFIED)
        return {
          ...base,
          status: 'FOUND',
          product: toCatalogProductDto(product),
          salonStock,
        };
      // Unverified details are only shown to the salon that submitted them.
      if (product.submittedBySalonId === salonId)
        return {
          ...base,
          status: 'FOUND_PENDING',
          product: toCatalogProductDto(product),
          salonStock,
        };
      return {
        ...base,
        status: 'PENDING_ELSEWHERE',
        pendingProductId: product.id,
        salonStock,
      };
    }
    const suggestion = await this.openBeautyFacts.lookup(barcode.display);
    return suggestion
      ? { ...base, status: 'EXTERNAL', suggestion }
      : { ...base, status: 'NOT_FOUND' };
  }

  /** A product the scan didn't find, submitted by a salon — PENDING until a FastQue admin verifies it. */
  async submit(
    userId: string,
    salonId: string,
    input: SubmitCatalogProductInput,
  ): Promise<CatalogProductDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const barcode = normalizeBarcode(input.barcode, input.barcodeHint);
    if (!barcode.ok)
      throw new AppException(
        CatalogErrorCode.INVALID_BARCODE,
        barcode.reason,
        HttpStatus.BAD_REQUEST,
      );
    const salon = await this.prisma.salon.findUnique({
      where: { id: salonId },
      select: { currency: true },
    });
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const product = await tx.globalProduct.create({
          data: {
            name: input.name.trim(),
            normalizedName: normalizeProductName(input.name),
            brand: input.brand?.trim() || null,
            manufacturer: input.manufacturer?.trim() || null,
            category: input.category?.trim() || null,
            subcategory: input.subcategory?.trim() || null,
            description: input.description?.trim() || null,
            packSize: input.packSize?.toFixed(3) ?? null,
            packUnit: input.packUnit ?? null,
            mrp: input.mrp?.toFixed(2) ?? null,
            currency: input.mrp != null ? (salon?.currency ?? 'INR') : null,
            hsnCode: input.hsnCode ?? null,
            gstRatePercent: input.gstRatePercent?.toFixed(2) ?? null,
            productType: input.productType,
            dataSource: input.dataSource,
            sourceReference: input.sourceReference?.trim() || null,
            sourceLicense:
              input.dataSource === ProductDataSource.OPEN_BEAUTY_FACTS
                ? 'ODbL-1.0'
                : null,
            verificationStatus: ProductVerificationStatus.PENDING,
            submittedBySalonId: salonId,
            createdByUserId: userId,
            barcodes: {
              create: {
                code: barcode.code,
                display: barcode.display,
                format: barcode.format,
              },
            },
            images: {
              create: input.imageUrls.map((url, sortOrder) => ({
                url,
                sortOrder,
              })),
            },
          },
          include: catalogProductInclude,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: userId,
            action: 'CATALOG_PRODUCT_SUBMITTED',
            entityType: 'GlobalProduct',
            entityId: product.id,
            metadata: {
              salonId,
              barcode: barcode.code,
              dataSource: input.dataSource,
            },
          },
        });
        return product;
      });
      return toCatalogProductDto(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(
          CatalogErrorCode.BARCODE_EXISTS,
          'This barcode is already in the FastQue catalog. Scan it again to use the existing product.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Receive stock of a catalog product: finds or creates this salon's own product for that catalog
   * entry and shelf, applies the salon's selling price / location / reorder level when given, and
   * records the incoming stock through the ledger (opening stock for a brand-new product without a
   * supplier, a purchase otherwise). Safe to retry with the same Idempotency-Key.
   */
  async receive(
    userId: string,
    salonId: string,
    idempotencyKey: string | undefined,
    input: ReceiveCatalogStockInput,
  ): Promise<{
    product: InventoryProductDto;
    movement: InventoryMovementDto;
    created: boolean;
  }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    if (!idempotencyKey?.trim())
      throw new AppException(
        InventoryErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key header is required.',
        HttpStatus.BAD_REQUEST,
      );

    const catalog = await this.prisma.globalProduct.findUnique({
      where: { id: input.globalProductId },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        submittedBySalonId: true,
      },
    });
    if (
      !catalog ||
      catalog.verificationStatus === ProductVerificationStatus.REJECTED
    )
      throw new AppException(
        CatalogErrorCode.NOT_USABLE,
        'This catalog product is not available.',
        HttpStatus.NOT_FOUND,
      );
    const detailsVisible =
      catalog.verificationStatus === ProductVerificationStatus.VERIFIED ||
      catalog.submittedBySalonId === salonId;
    const productName =
      input.name?.trim() || (detailsVisible ? catalog.name : null);
    if (!productName)
      throw new AppException(
        CatalogErrorCode.NOT_USABLE,
        'Enter a product name — this barcode is still being reviewed by FastQue.',
        HttpStatus.BAD_REQUEST,
      );

    // A retry after a lost response: the earlier stock entry is the answer.
    const earlier = await this.prisma.inventoryMovement.findUnique({
      where: { salonId_idempotencyKey: { salonId, idempotencyKey } },
      select: { productId: true, kind: true },
    });

    let inventoryProductId: string;
    let isNew = false;
    if (earlier) {
      inventoryProductId = earlier.productId;
    } else {
      const existing = await this.prisma.inventoryProduct.findFirst({
        where: {
          salonId,
          globalProductId: catalog.id,
          usage: input.usage,
        },
        select: { id: true },
      });
      if (existing) inventoryProductId = existing.id;
      else {
        try {
          const created = await this.prisma.inventoryProduct.create({
            data: {
              salonId,
              globalProductId: catalog.id,
              usage: input.usage,
              name: productName.slice(0, 120),
              normalizedName: normalizeProductName(productName).slice(0, 120),
              // Counted in packs/pieces unless the salon says otherwise; packUnit describes one pack's contents.
              unit: input.unit ?? 'EACH',
              supplierId: input.supplierId ?? null,
              reorderThreshold: (input.reorderThreshold ?? 0).toFixed(3),
              sellingPrice: input.sellingPrice?.toFixed(2) ?? null,
              storageLocation: input.storageLocation?.trim() || null,
            },
            select: { id: true },
          });
          inventoryProductId = created.id;
          isNew = true;
          await this.prisma.auditLog.create({
            data: {
              actorUserId: userId,
              action: 'INVENTORY_PRODUCT_CREATED',
              entityType: 'InventoryProduct',
              entityId: created.id,
              metadata: {
                salonId,
                globalProductId: catalog.id,
                usage: input.usage,
              },
            },
          });
        } catch (error) {
          // Someone else created it a moment ago (two devices scanning at once).
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            const raced = await this.prisma.inventoryProduct.findFirstOrThrow({
              where: {
                salonId,
                globalProductId: catalog.id,
                usage: input.usage,
              },
              select: { id: true },
            });
            inventoryProductId = raced.id;
          } else throw error;
        }
      }
      if (!isNew) {
        const changes: Prisma.InventoryProductUpdateInput = {
          ...(input.sellingPrice !== undefined
            ? { sellingPrice: input.sellingPrice?.toFixed(2) ?? null }
            : {}),
          ...(input.storageLocation !== undefined
            ? { storageLocation: input.storageLocation?.trim() || null }
            : {}),
          ...(input.reorderThreshold !== undefined
            ? { reorderThreshold: input.reorderThreshold.toFixed(3) }
            : {}),
        };
        if (Object.keys(changes).length)
          await this.prisma.inventoryProduct.update({
            where: { id: inventoryProductId },
            data: changes,
          });
      }
    }

    // A retry repeats the original entry exactly (same kind), so the ledger returns it unchanged.
    const kind = earlier
      ? (earlier.kind as
          typeof MovementKind.OPENING | typeof MovementKind.PURCHASE)
      : (await this.prisma.inventoryMovement.count({
            where: { productId: inventoryProductId },
          })) === 0 && !input.supplierId
        ? MovementKind.OPENING
        : MovementKind.PURCHASE;
    const { movement, created } = await this.inventory.createMovement(
      userId,
      salonId,
      inventoryProductId,
      idempotencyKey,
      {
        kind,
        quantity: input.quantity,
        unitCost: input.unitCost,
        ...(kind === MovementKind.PURCHASE && input.supplierId
          ? { supplierId: input.supplierId }
          : {}),
        ...(input.reference ? { reference: input.reference } : {}),
        batchNumber: input.batchNumber ?? null,
        expiryDate: input.expiryDate ?? null,
      },
    );
    const product = await this.inventory.getProduct(
      salonId,
      inventoryProductId,
    );
    return { product, movement, created };
  }

  /**
   * Move stock between the professional and retail shelves of the same catalog product. Both sides
   * are locked in a fixed order and written as a TRANSFER_OUT/TRANSFER_IN pair sharing one
   * transferGroupId; the incoming side carries the source's average cost. Retry-safe.
   */
  async transfer(
    userId: string,
    salonId: string,
    productId: string,
    idempotencyKey: string | undefined,
    input: TransferStockInput,
  ): Promise<{ from: InventoryProductDto; to: InventoryProductDto }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 120)
      throw new AppException(
        InventoryErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'An Idempotency-Key header (up to 120 characters) is required.',
        HttpStatus.BAD_REQUEST,
      );
    const source = await this.prisma.inventoryProduct.findFirst({
      where: { id: productId, salonId },
    });
    if (!source)
      throw new AppException(
        InventoryErrorCode.PRODUCT_NOT_FOUND,
        'Inventory product not found.',
        HttpStatus.NOT_FOUND,
      );
    if (!source.globalProductId)
      throw new AppException(
        InventoryErrorCode.INVALID_MOVEMENT,
        'Only products linked to the FastQue catalog can move between shelves.',
        HttpStatus.BAD_REQUEST,
      );
    const targetUsage =
      source.usage === 'PROFESSIONAL' ? 'RETAIL' : 'PROFESSIONAL';

    const target =
      (await this.prisma.inventoryProduct.findFirst({
        where: {
          salonId,
          globalProductId: source.globalProductId,
          usage: targetUsage,
        },
      })) ??
      (await this.prisma.inventoryProduct
        .create({
          data: {
            salonId,
            globalProductId: source.globalProductId,
            usage: targetUsage,
            name: source.name,
            normalizedName: source.normalizedName,
            unit: source.unit,
            categoryId: source.categoryId,
            supplierId: source.supplierId,
          },
        })
        .catch(async (error: unknown) => {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          )
            return this.prisma.inventoryProduct.findFirstOrThrow({
              where: {
                salonId,
                globalProductId: source.globalProductId!,
                usage: targetUsage,
              },
            });
          throw error;
        }));

    const outKey = `${key}:out`;
    const already = await this.prisma.inventoryMovement.findUnique({
      where: { salonId_idempotencyKey: { salonId, idempotencyKey: outKey } },
    });
    if (!already) {
      const groupId = randomUUID();
      const quantity = new Prisma.Decimal(input.quantity.toFixed(3));
      const hash = (side: string) =>
        createHash('sha256')
          .update(
            JSON.stringify({
              userId,
              salonId,
              productId,
              side,
              quantity: quantity.toFixed(3),
            }),
          )
          .digest('hex');
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const [first, second] = [source.id, target.id].sort();
            const locked = await tx.$queryRaw<
              Array<{
                id: string;
                stockOnHand: Prisma.Decimal;
                averageUnitCost: Prisma.Decimal;
              }>
            >(Prisma.sql`
              SELECT "id", "stockOnHand", "averageUnitCost" FROM "inventory_products"
              WHERE "salonId" = ${salonId} AND "id" IN (${first}, ${second})
              ORDER BY "id" FOR UPDATE
            `);
            const from = locked.find((r) => r.id === source.id)!;
            if (from.stockOnHand.lessThan(quantity))
              throw new AppException(
                InventoryErrorCode.INSUFFICIENT_STOCK,
                'There is not enough stock on this shelf to move.',
                HttpStatus.CONFLICT,
              );
            const reason = input.reason?.trim() || null;
            await tx.inventoryMovement.create({
              data: {
                salonId,
                productId: source.id,
                actorUserId: userId,
                kind: MovementKind.TRANSFER_OUT,
                quantityDelta: quantity.negated(),
                reason,
                transferGroupId: groupId,
                idempotencyKey: outKey,
                requestHash: hash('out'),
              },
            });
            await tx.inventoryMovement.create({
              data: {
                salonId,
                productId: target.id,
                actorUserId: userId,
                kind: MovementKind.TRANSFER_IN,
                quantityDelta: quantity,
                unitCost: from.averageUnitCost,
                reason,
                transferGroupId: groupId,
                idempotencyKey: `${key}:in`,
                requestHash: hash('in'),
              },
            });
            await tx.auditLog.create({
              data: {
                actorUserId: userId,
                action: 'INVENTORY_SHELF_TRANSFER',
                entityType: 'InventoryProduct',
                entityId: source.id,
                metadata: {
                  salonId,
                  toProductId: target.id,
                  toUsage: targetUsage,
                  quantity: quantity.toFixed(3),
                  transferGroupId: groupId,
                },
              },
            });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 10000,
          },
        );
      } catch (error) {
        // The same transfer finishing on another request first is still a success.
        if (!(
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ))
          throw error;
      }
    }
    return {
      from: await this.inventory.getProduct(salonId, source.id),
      to: await this.inventory.getProduct(salonId, target.id),
    };
  }
}
