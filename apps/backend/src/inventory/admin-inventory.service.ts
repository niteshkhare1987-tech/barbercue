import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CatalogErrorCode,
  INVENTORY_LOSS_KINDS,
  ProductDataSource,
  ProductVerificationStatus,
  validateCatalogCsv,
  type AdminCatalogImportInput,
  type AdminCatalogListQuery,
  type AdminCatalogProductDto,
  type AdminCatalogReviewInput,
  type AdminInventoryOverviewDto,
  type AdminInventoryOverviewQuery,
  type CatalogImportRowResult,
  type InventoryPageDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  catalogProductInclude,
  normalizeProductName,
  toCatalogProductDto,
} from './product-catalog.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD range → [start, end) instants (UTC days); defaults to the last 30 days. */
export function overviewRange(query: AdminInventoryOverviewQuery): {
  from: string;
  to: string;
  start: Date;
  end: Date;
} {
  const today = new Date().toISOString().slice(0, 10);
  const to = query.to ?? today;
  const from =
    query.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS)
      .toISOString()
      .slice(0, 10);
  if (from > to)
    throw new AppException(
      'INVALID_RANGE',
      'The start date must be on or before the end date.',
      HttpStatus.BAD_REQUEST,
    );
  return {
    from,
    to,
    start: new Date(`${from}T00:00:00Z`),
    end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS),
  };
}

const adminProductInclude = {
  ...catalogProductInclude,
  submittedBySalon: { select: { id: true, name: true } },
  _count: { select: { inventoryProducts: true } },
} satisfies Prisma.GlobalProductInclude;

/**
 * FastQue admin side of inventory (Inventory Phase 1): platform-wide and shop-wise inventory KPIs,
 * the Global Product Master review queue, and verified bulk CSV import. Read-only for viewers;
 * reviews and imports are restricted at the controller (platform admin / co-founder).
 */
@Injectable()
export class AdminInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(
    query: AdminInventoryOverviewQuery,
  ): Promise<AdminInventoryOverviewDto> {
    const range = overviewRange(query);
    const salonFilter = query.salonId
      ? Prisma.sql`AND p."salonId" = ${query.salonId}`
      : Prisma.empty;
    const movementSalonFilter = query.salonId
      ? Prisma.sql`AND m."salonId" = ${query.salonId}`
      : Prisma.empty;

    const [shops, movementCounts, totals, catalog, top] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          salonId: string;
          name: string;
          city: string | null;
          products: bigint;
          stockValue: Prisma.Decimal | null;
          lowStock: bigint;
          outOfStock: bigint;
          lastUpdate: Date | null;
        }>
      >(Prisma.sql`
        SELECT p."salonId", s."name", c."name" AS "city",
          COUNT(*) FILTER (WHERE p."isActive") AS "products",
          COALESCE(SUM(p."stockOnHand" * p."averageUnitCost") FILTER (WHERE p."isActive"), 0) AS "stockValue",
          COUNT(*) FILTER (WHERE p."isActive" AND p."stockOnHand" > 0 AND p."stockOnHand" <= p."reorderThreshold") AS "lowStock",
          COUNT(*) FILTER (WHERE p."isActive" AND p."stockOnHand" = 0) AS "outOfStock",
          MAX(p."updatedAt") AS "lastUpdate"
        FROM "inventory_products" p
        JOIN "salons" s ON s."id" = p."salonId"
        LEFT JOIN "cities" c ON c."id" = s."cityId"
        WHERE true ${salonFilter}
        GROUP BY p."salonId", s."name", c."name"
        ORDER BY "stockValue" DESC, s."name" ASC
      `),
      this.prisma.$queryRaw<
        Array<{ salonId: string; count: bigint }>
      >(Prisma.sql`
        SELECT m."salonId", COUNT(*) AS "count"
        FROM "inventory_movements" m
        WHERE m."recordedAt" >= ${range.start} AND m."recordedAt" < ${range.end} ${movementSalonFilter}
        GROUP BY m."salonId"
      `),
      this.prisma.$queryRaw<
        Array<{
          purchasesValue: Prisma.Decimal | null;
          purchaseEntries: bigint;
          consumptionEntries: bigint;
          lossEntries: bigint;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(m."quantityDelta" * m."unitCost") FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')), 0) AS "purchasesValue",
          COUNT(*) FILTER (WHERE m."kind" IN ('OPENING', 'PURCHASE')) AS "purchaseEntries",
          COUNT(*) FILTER (WHERE m."kind" = 'CONSUMPTION') AS "consumptionEntries",
          COUNT(*) FILTER (WHERE m."kind"::text IN (${Prisma.join([...INVENTORY_LOSS_KINDS])})) AS "lossEntries"
        FROM "inventory_movements" m
        WHERE m."recordedAt" >= ${range.start} AND m."recordedAt" < ${range.end} ${movementSalonFilter}
      `),
      this.prisma.globalProduct.groupBy({
        by: ['verificationStatus'],
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<
        Array<{
          id: string;
          name: string;
          brand: string | null;
          salons: bigint;
        }>
      >(Prisma.sql`
        SELECT g."id", g."name", g."brand", COUNT(DISTINCT p."salonId") AS "salons"
        FROM "inventory_products" p
        JOIN "global_products" g ON g."id" = p."globalProductId"
        WHERE p."isActive" ${salonFilter}
        GROUP BY g."id", g."name", g."brand"
        ORDER BY "salons" DESC, g."name" ASC
        LIMIT 10
      `),
    ]);

    const movementsBy = new Map(
      movementCounts.map((r) => [r.salonId, Number(r.count)]),
    );
    const sum = (pick: (s: (typeof shops)[number]) => bigint) =>
      shops.reduce((total, shop) => total + Number(pick(shop)), 0);
    const stockValue = shops.reduce(
      (total, shop) => total.plus(shop.stockValue ?? 0),
      new Prisma.Decimal(0),
    );
    const catalogCount = (status: string) =>
      catalog.find((c) => c.verificationStatus === status)?._count._all ?? 0;
    const t = totals[0];

    return {
      range: { from: range.from, to: range.to },
      salonId: query.salonId ?? null,
      kpis: {
        shopsUsingInventory: shops.length,
        productsTracked: sum((s) => s.products),
        stockValue: stockValue.toFixed(2),
        lowStockItems: sum((s) => s.lowStock),
        outOfStockItems: sum((s) => s.outOfStock),
        purchasesValue: new Prisma.Decimal(t?.purchasesValue ?? 0).toFixed(2),
        purchaseEntries: Number(t?.purchaseEntries ?? 0),
        consumptionEntries: Number(t?.consumptionEntries ?? 0),
        lossEntries: Number(t?.lossEntries ?? 0),
        catalogVerified: catalogCount(ProductVerificationStatus.VERIFIED),
        catalogPending: catalogCount(ProductVerificationStatus.PENDING),
      },
      shops: shops.map((shop) => ({
        salonId: shop.salonId,
        name: shop.name,
        city: shop.city,
        productsTracked: Number(shop.products),
        stockValue: new Prisma.Decimal(shop.stockValue ?? 0).toFixed(2),
        lowStockItems: Number(shop.lowStock),
        outOfStockItems: Number(shop.outOfStock),
        movementsInRange: movementsBy.get(shop.salonId) ?? 0,
        lastStockUpdate: shop.lastUpdate?.toISOString() ?? null,
      })),
      topProducts: top.map((row) => ({
        globalProductId: row.id,
        name: row.name,
        brand: row.brand,
        salons: Number(row.salons),
      })),
    };
  }

  async listCatalog(
    query: AdminCatalogListQuery,
  ): Promise<InventoryPageDto<AdminCatalogProductDto>> {
    const q = query.q?.trim();
    const where: Prisma.GlobalProductWhereInput = {
      ...(query.status ? { verificationStatus: query.status } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { barcodes: { some: { display: { contains: q } } } },
            ],
          }
        : {}),
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
    };
    const rows = await this.prisma.globalProduct.findMany({
      where,
      include: adminProductInclude,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    // Possible duplicates: other non-rejected products with the same name and brand.
    const names = [...new Set(page.map((p) => p.normalizedName))];
    const similar = names.length
      ? await this.prisma.globalProduct.findMany({
          where: {
            normalizedName: { in: names },
            verificationStatus: { not: ProductVerificationStatus.REJECTED },
          },
          select: { id: true, name: true, brand: true, normalizedName: true },
        })
      : [];
    return {
      items: page.map((row) => ({
        ...toCatalogProductDto(row),
        submittedBySalon: row.submittedBySalon,
        reviewNote: row.reviewNote,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        salonsStocking: row._count.inventoryProducts,
        possibleDuplicates: similar
          .filter(
            (s) =>
              s.id !== row.id &&
              s.normalizedName === row.normalizedName &&
              (s.brand ?? '').toLowerCase() === (row.brand ?? '').toLowerCase(),
          )
          .map((s) => ({ id: s.id, name: s.name, brand: s.brand })),
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1].id : null,
      hasMore: rows.length > query.limit,
    };
  }

  async review(
    adminUserId: string,
    productId: string,
    input: AdminCatalogReviewInput,
  ): Promise<AdminCatalogProductDto> {
    const existing = await this.prisma.globalProduct.findUnique({
      where: { id: productId },
    });
    if (!existing)
      throw new AppException(
        CatalogErrorCode.PRODUCT_NOT_FOUND,
        'Catalog product not found.',
        HttpStatus.NOT_FOUND,
      );
    const fields = input.fields ?? {};
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.globalProduct.update({
        where: { id: productId },
        data: {
          ...(fields.name
            ? {
                name: fields.name.trim(),
                normalizedName: normalizeProductName(fields.name),
              }
            : {}),
          ...(fields.brand !== undefined
            ? { brand: fields.brand?.trim() || null }
            : {}),
          ...(fields.manufacturer !== undefined
            ? { manufacturer: fields.manufacturer?.trim() || null }
            : {}),
          ...(fields.category !== undefined
            ? { category: fields.category?.trim() || null }
            : {}),
          ...(fields.subcategory !== undefined
            ? { subcategory: fields.subcategory?.trim() || null }
            : {}),
          ...(fields.description !== undefined
            ? { description: fields.description?.trim() || null }
            : {}),
          ...(fields.packSize !== undefined
            ? { packSize: fields.packSize?.toFixed(3) ?? null }
            : {}),
          ...(fields.packUnit !== undefined
            ? { packUnit: fields.packUnit ?? null }
            : {}),
          ...(fields.mrp !== undefined
            ? { mrp: fields.mrp?.toFixed(2) ?? null }
            : {}),
          ...(fields.hsnCode !== undefined
            ? { hsnCode: fields.hsnCode ?? null }
            : {}),
          ...(fields.gstRatePercent !== undefined
            ? { gstRatePercent: fields.gstRatePercent?.toFixed(2) ?? null }
            : {}),
          ...(fields.productType !== undefined
            ? { productType: fields.productType }
            : {}),
          verificationStatus:
            input.action === 'VERIFY'
              ? ProductVerificationStatus.VERIFIED
              : ProductVerificationStatus.REJECTED,
          reviewedByUserId: adminUserId,
          reviewedAt: new Date(),
          reviewNote: input.note?.trim() || null,
        },
        include: adminProductInclude,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: adminUserId,
          action:
            input.action === 'VERIFY'
              ? 'CATALOG_PRODUCT_VERIFIED'
              : 'CATALOG_PRODUCT_REJECTED',
          entityType: 'GlobalProduct',
          entityId: productId,
          metadata: {
            previousStatus: existing.verificationStatus,
            editedFields: Object.keys(fields),
          },
        },
      });
      return row;
    });
    return {
      ...toCatalogProductDto(updated),
      submittedBySalon: updated.submittedBySalon,
      reviewNote: updated.reviewNote,
      reviewedAt: updated.reviewedAt?.toISOString() ?? null,
      salonsStocking: updated._count.inventoryProducts,
      possibleDuplicates: [],
    };
  }

  /** Validates an uploaded CSV row by row without saving anything. */
  async importPreview(csv: string): Promise<{
    rows: CatalogImportRowResult[];
    headerErrors: string[];
    summary: Record<CatalogImportRowResult['status'], number>;
  }> {
    const firstPass = validateCatalogCsv(csv, new Set());
    const codes = firstPass.rows
      .map((r) => r.product?.barcode)
      .filter((c): c is string => !!c);
    const existing = new Set(
      codes.length
        ? (
            await this.prisma.globalProductBarcode.findMany({
              where: { code: { in: codes } },
              select: { code: true },
            })
          ).map((b) => b.code)
        : [],
    );
    const result = validateCatalogCsv(csv, existing);
    const summary = { NEW: 0, DUPLICATE_IN_FILE: 0, EXISTS: 0, INVALID: 0 };
    for (const row of result.rows) summary[row.status] += 1;
    return { ...result, summary };
  }

  /**
   * Saves the file's NEW rows as VERIFIED catalog products (admin-imported, with the given source
   * and licence). Rows that already exist, repeat a barcode or fail validation are skipped and
   * reported. Re-running the same file only adds what is still missing.
   */
  async importCommit(
    adminUserId: string,
    csv: string,
    input: AdminCatalogImportInput,
  ): Promise<{
    created: number;
    skipped: number;
    headerErrors: string[];
    rows: CatalogImportRowResult[];
  }> {
    const preview = await this.importPreview(csv);
    if (preview.headerErrors.length)
      throw new AppException(
        CatalogErrorCode.IMPORT_INVALID,
        preview.headerErrors.join(' '),
        HttpStatus.BAD_REQUEST,
      );
    let created = 0;
    const rows = preview.rows;
    const toCreate = rows.filter((r) => r.status === 'NEW' && r.product);
    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      await this.prisma.$transaction(async (tx) => {
        for (const row of chunk) {
          const p = row.product!;
          const taken = await tx.globalProductBarcode.findUnique({
            where: { code: p.barcode },
            select: { id: true },
          });
          if (taken) {
            row.status = 'EXISTS';
            continue;
          }
          await tx.globalProduct.create({
            data: {
              name: p.name,
              normalizedName: normalizeProductName(p.name),
              brand: p.brand ?? null,
              manufacturer: p.manufacturer ?? null,
              category: p.category ?? null,
              subcategory: p.subcategory ?? null,
              description: p.description ?? null,
              packSize: p.packSize?.toFixed(3) ?? null,
              packUnit: p.packUnit ?? null,
              mrp: p.mrp?.toFixed(2) ?? null,
              currency: p.mrp != null ? 'INR' : null,
              hsnCode: p.hsnCode ?? null,
              gstRatePercent: p.gstRatePercent?.toFixed(2) ?? null,
              productType: p.productType,
              dataSource: ProductDataSource.CSV_IMPORT,
              sourceReference: input.sourceReference,
              sourceLicense: input.sourceLicense,
              verificationStatus: ProductVerificationStatus.VERIFIED,
              createdByUserId: adminUserId,
              reviewedByUserId: adminUserId,
              reviewedAt: new Date(),
              barcodes: {
                create: {
                  code: p.barcode,
                  display: p.displayBarcode,
                  format: /^\d{14}$/.test(p.barcode) ? 'GTIN' : 'OTHER',
                },
              },
              ...(p.imageUrl
                ? { images: { create: { url: p.imageUrl, sortOrder: 0 } } }
                : {}),
            },
          });
          created += 1;
        }
      });
    }
    await this.prisma.auditLog.create({
      data: {
        actorUserId: adminUserId,
        action: 'CATALOG_IMPORTED',
        entityType: 'GlobalProduct',
        entityId: 'import',
        metadata: {
          created,
          rows: rows.length,
          sourceReference: input.sourceReference,
          sourceLicense: input.sourceLicense,
        },
      },
    });
    return {
      created,
      skipped: rows.length - created,
      headerErrors: [],
      rows: rows.filter((r) => r.status !== 'NEW'),
    };
  }
}
