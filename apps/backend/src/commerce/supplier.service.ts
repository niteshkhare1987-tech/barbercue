import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CommerceErrorCode,
  PO_TRANSITIONS,
  normalizeBarcode,
  validateOfferCsv,
  type MarketplaceSupplierDto,
  type PurchaseOrderDto,
  type PurchaseOrderStatus,
  type SupplierApplicationInput,
  type SupplierOfferDto,
  type SupplierOfferInput,
  type SupplierOrderDecisionInput,
  type UpdateSupplierProfileInput,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCE_TX, money } from './commerce-ledger';
import { poInclude, toPoDto } from './purchase-order.service';

type SupplierRow = Prisma.MarketplaceSupplierGetPayload<{
  include: {
    city: { select: { name: true } };
    _count: { select: { offers: true } };
  };
}>;

export function toSupplierDto(s: SupplierRow): MarketplaceSupplierDto {
  return {
    id: s.id,
    name: s.name,
    legalName: s.legalName,
    gstin: s.gstin,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email,
    address: s.address,
    cityId: s.cityId,
    cityName: s.city?.name ?? null,
    serviceCityIds: s.serviceCityIds,
    defaultLeadTimeDays: s.defaultLeadTimeDays,
    deliveryCharge: money(s.deliveryCharge),
    freeDeliveryAbove: s.freeDeliveryAbove ? money(s.freeDeliveryAbove) : null,
    minimumOrderValue: s.minimumOrderValue ? money(s.minimumOrderValue) : null,
    status: s.status,
    reviewNote: s.reviewNote,
    offerCount: s._count.offers,
    createdAt: s.createdAt.toISOString(),
  };
}
export const supplierInclude = {
  city: { select: { name: true } },
  _count: { select: { offers: true } },
} as const;

const offerInclude = {
  globalProduct: {
    select: {
      name: true,
      brand: true,
      barcodes: { take: 1, select: { display: true } },
      images: {
        take: 1,
        orderBy: { sortOrder: 'asc' as const },
        select: { url: true },
      },
    },
  },
} satisfies Prisma.SupplierOfferInclude;

function toOfferDto(
  o: Prisma.SupplierOfferGetPayload<{ include: typeof offerInclude }>,
): SupplierOfferDto {
  return {
    id: o.id,
    globalProductId: o.globalProductId,
    productName: o.globalProduct.name,
    brand: o.globalProduct.brand,
    barcode: o.globalProduct.barcodes[0]?.display ?? null,
    imageUrl: o.globalProduct.images[0]?.url ?? null,
    supplierSku: o.supplierSku,
    unitPrice: money(o.unitPrice),
    minOrderQuantity: o.minOrderQuantity,
    availableQuantity: o.availableQuantity,
    leadTimeDays: o.leadTimeDays,
    isActive: o.isActive,
    updatedAt: o.updatedAt.toISOString(),
  };
}

/**
 * Inventory Phase 4 — the supplier portal. Any signed-in person can apply; a FastQue admin approves
 * (AdminCommerceService). Portal access is membership of an APPROVED supplier, checked on every
 * request. Approved suppliers manage their price list against VERIFIED catalog products only and
 * act on the purchase orders salons place with them. FastQue never contacts anyone from here.
 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The supplier this user belongs to (any status), or null. */
  private async membership(userId: string) {
    const m = await this.prisma.supplierMember.findFirst({
      where: { userId },
      include: { supplier: { include: supplierInclude } },
      orderBy: { createdAt: 'asc' },
    });
    return m?.supplier ?? null;
  }

  private async approved(userId: string) {
    const s = await this.membership(userId);
    if (!s)
      throw new AppException(
        CommerceErrorCode.NOT_A_SUPPLIER,
        'This account is not a FastQue supplier.',
        HttpStatus.FORBIDDEN,
      );
    if (s.status !== 'APPROVED')
      throw new AppException(
        CommerceErrorCode.SUPPLIER_NOT_APPROVED,
        s.status === 'PENDING'
          ? 'Your application is waiting for FastQue to review it.'
          : 'This supplier account is not active.',
        HttpStatus.FORBIDDEN,
      );
    return s;
  }

  async me(userId: string): Promise<MarketplaceSupplierDto | null> {
    const s = await this.membership(userId);
    return s ? toSupplierDto(s) : null;
  }

  async apply(
    userId: string,
    input: SupplierApplicationInput,
  ): Promise<MarketplaceSupplierDto> {
    if (await this.membership(userId))
      throw new AppException(
        CommerceErrorCode.ALREADY_APPLIED,
        'You have already applied. FastQue will review it.',
        HttpStatus.CONFLICT,
      );
    const cities = await this.prisma.city.count({
      where: { id: { in: [input.cityId, ...input.serviceCityIds] } },
    });
    if (cities < new Set([input.cityId, ...input.serviceCityIds]).size)
      throw new AppException(
        CommerceErrorCode.OFFER_INVALID,
        'Choose cities from the list.',
        HttpStatus.BAD_REQUEST,
      );
    const s = await this.prisma.$transaction(async (tx) => {
      const created = await tx.marketplaceSupplier.create({
        data: {
          ...input,
          serviceCityIds: [...new Set(input.serviceCityIds)],
          legalName: input.legalName?.trim() || null,
          gstin: input.gstin || null,
          deliveryCharge: new Prisma.Decimal(input.deliveryCharge),
          freeDeliveryAbove:
            input.freeDeliveryAbove != null
              ? new Prisma.Decimal(input.freeDeliveryAbove)
              : null,
          minimumOrderValue:
            input.minimumOrderValue != null
              ? new Prisma.Decimal(input.minimumOrderValue)
              : null,
          createdByUserId: userId,
          members: { create: { userId } },
        },
        include: supplierInclude,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'SUPPLIER_APPLIED',
          entityType: 'MarketplaceSupplier',
          entityId: created.id,
          metadata: { name: created.name },
        },
      });
      return created;
    });
    return toSupplierDto(s);
  }

  async updateProfile(
    userId: string,
    input: UpdateSupplierProfileInput,
  ): Promise<MarketplaceSupplierDto> {
    const s = await this.approved(userId);
    const data: Prisma.MarketplaceSupplierUpdateInput = {};
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (
        ['deliveryCharge', 'freeDeliveryAbove', 'minimumOrderValue'].includes(k)
      )
        (data as Record<string, unknown>)[k] =
          v === null ? null : new Prisma.Decimal(v as number);
      else if (k === 'cityId') data.city = { connect: { id: v as string } };
      else if (k === 'serviceCityIds')
        data.serviceCityIds = [...new Set(v as string[])];
      else (data as Record<string, unknown>)[k] = v;
    }
    const updated = await this.prisma.marketplaceSupplier.update({
      where: { id: s.id },
      data,
      include: supplierInclude,
    });
    return toSupplierDto(updated);
  }

  // ---------- Price list ----------

  async listOffers(userId: string): Promise<SupplierOfferDto[]> {
    const s = await this.approved(userId);
    const rows = await this.prisma.supplierOffer.findMany({
      where: { supplierId: s.id },
      include: offerInclude,
      orderBy: { globalProduct: { normalizedName: 'asc' } },
    });
    return rows.map(toOfferDto);
  }

  async upsertOffer(
    userId: string,
    input: SupplierOfferInput,
  ): Promise<SupplierOfferDto> {
    const s = await this.approved(userId);
    const product = await this.prisma.globalProduct.findUnique({
      where: { id: input.globalProductId },
      select: { verificationStatus: true },
    });
    if (product?.verificationStatus !== 'VERIFIED')
      throw new AppException(
        CommerceErrorCode.OFFER_INVALID,
        'Only products verified in the FastQue catalog can be offered.',
        HttpStatus.BAD_REQUEST,
      );
    const data = {
      supplierSku: input.supplierSku?.trim() || null,
      unitPrice: new Prisma.Decimal(input.unitPrice),
      minOrderQuantity: input.minOrderQuantity,
      availableQuantity: input.availableQuantity ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      isActive: input.isActive,
      stockUpdatedAt: new Date(),
    };
    const row = await this.prisma.supplierOffer.upsert({
      where: {
        supplierId_globalProductId: {
          supplierId: s.id,
          globalProductId: input.globalProductId,
        },
      },
      create: {
        supplierId: s.id,
        globalProductId: input.globalProductId,
        ...data,
      },
      update: data,
      include: offerInclude,
    });
    return toOfferDto(row);
  }

  /** Verified catalog products a supplier can add (search by name, brand or barcode). */
  async searchCatalog(userId: string, q: string) {
    await this.approved(userId);
    const term = q.trim();
    const n = normalizeBarcode(term);
    const rows = await this.prisma.globalProduct.findMany({
      where: {
        verificationStatus: 'VERIFIED',
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { brand: { contains: term, mode: 'insensitive' } },
                ...(n.ok ? [{ barcodes: { some: { code: n.code } } }] : []),
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        brand: true,
        barcodes: { take: 1, select: { display: true } },
      },
      orderBy: { normalizedName: 'asc' },
      take: 30,
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      barcode: r.barcodes[0]?.display ?? null,
    }));
  }

  private async csvRows(csv: string) {
    const codes = new Set<string>();
    // Pre-collect normalised barcodes so one query resolves the whole file.
    const probe = validateOfferCsv(
      csv,
      (raw) => {
        const n = normalizeBarcode(raw);
        if (n.ok) codes.add(n.code);
        return n.ok ? n.code : null;
      },
      new Map(),
    );
    if (probe.headerErrors.length) return probe;
    const known = await this.prisma.globalProductBarcode.findMany({
      where: {
        code: { in: [...codes] },
        product: { verificationStatus: 'VERIFIED' },
      },
      select: { code: true, productId: true },
    });
    return validateOfferCsv(
      csv,
      (raw) => {
        const n = normalizeBarcode(raw);
        return n.ok ? n.code : null;
      },
      new Map(known.map((k) => [k.code, k.productId])),
    );
  }

  async importPreview(userId: string, csv: string) {
    await this.approved(userId);
    const result = await this.csvRows(csv);
    return {
      headerErrors: result.headerErrors,
      rows: result.rows.map((r) => ({
        line: r.line,
        barcode: r.barcode,
        status: r.status,
        errors: r.errors,
        offer: r.offer,
      })),
      summary: {
        OK: result.rows.filter((r) => r.status === 'OK').length,
        UNKNOWN_PRODUCT: result.rows.filter(
          (r) => r.status === 'UNKNOWN_PRODUCT',
        ).length,
        INVALID: result.rows.filter((r) => r.status === 'INVALID').length,
        DUPLICATE_IN_FILE: result.rows.filter(
          (r) => r.status === 'DUPLICATE_IN_FILE',
        ).length,
      },
    };
  }

  async importCommit(
    userId: string,
    csv: string,
  ): Promise<{ saved: number; skipped: number }> {
    const s = await this.approved(userId);
    const result = await this.csvRows(csv);
    if (result.headerErrors.length)
      throw new AppException(
        CommerceErrorCode.OFFER_INVALID,
        result.headerErrors.join(' '),
        HttpStatus.BAD_REQUEST,
      );
    const ok = result.rows.filter(
      (r) => r.status === 'OK' && r.offer && r.globalProductId,
    );
    for (let i = 0; i < ok.length; i += 100) {
      await this.prisma.$transaction(
        ok.slice(i, i + 100).map((r) =>
          this.prisma.supplierOffer.upsert({
            where: {
              supplierId_globalProductId: {
                supplierId: s.id,
                globalProductId: r.globalProductId!,
              },
            },
            create: {
              supplierId: s.id,
              globalProductId: r.globalProductId!,
              supplierSku: r.offer!.supplierSku,
              unitPrice: new Prisma.Decimal(r.offer!.unitPrice),
              minOrderQuantity: r.offer!.minOrderQuantity,
              availableQuantity: r.offer!.availableQuantity,
              leadTimeDays: r.offer!.leadTimeDays,
            },
            update: {
              supplierSku: r.offer!.supplierSku,
              unitPrice: new Prisma.Decimal(r.offer!.unitPrice),
              minOrderQuantity: r.offer!.minOrderQuantity,
              availableQuantity: r.offer!.availableQuantity,
              leadTimeDays: r.offer!.leadTimeDays,
              isActive: true,
              stockUpdatedAt: new Date(),
            },
          }),
        ),
      );
    }
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: 'SUPPLIER_OFFERS_IMPORTED',
        entityType: 'MarketplaceSupplier',
        entityId: s.id,
        metadata: { saved: ok.length },
      },
    });
    return { saved: ok.length, skipped: result.rows.length - ok.length };
  }

  // ---------- Incoming purchase orders ----------

  async orders(userId: string): Promise<PurchaseOrderDto[]> {
    const s = await this.approved(userId);
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { marketplaceSupplierId: s.id, status: { not: 'DRAFT' } },
      include: poInclude,
      orderBy: { placedAt: 'desc' },
      take: 200,
    });
    return rows.map(toPoDto);
  }

  async decide(
    userId: string,
    id: string,
    to: PurchaseOrderStatus,
    input: SupplierOrderDecisionInput,
  ): Promise<PurchaseOrderDto> {
    const s = await this.approved(userId);
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, marketplaceSupplierId: s.id },
      include: poInclude,
    });
    if (!po || po.status === 'DRAFT')
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Order not found.',
        HttpStatus.NOT_FOUND,
      );
    if (!PO_TRANSITIONS.SUPPLIER[po.status]?.includes(to))
      throw new AppException(
        CommerceErrorCode.PO_TRANSITION,
        `This order is ${po.status.toLowerCase()} and can't be moved to ${to.toLowerCase()}.`,
        HttpStatus.CONFLICT,
      );
    if (to === 'REJECTED' && !input.note?.trim())
      throw new AppException(
        CommerceErrorCode.PO_TRANSITION,
        'Tell the salon why.',
        HttpStatus.BAD_REQUEST,
      );
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.purchaseOrder.updateMany({
        where: { id, status: po.status },
        data: {
          status: to,
          supplierNote: input.note?.trim() || po.supplierNote,
          ...(input.expectedDeliveryDate
            ? {
                expectedDeliveryDate: new Date(
                  `${input.expectedDeliveryDate}T00:00:00.000Z`,
                ),
              }
            : {}),
          ...(to === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
          ...(to === 'DISPATCHED' ? { dispatchedAt: new Date() } : {}),
          ...(to === 'REJECTED' ? { closedAt: new Date() } : {}),
        },
      });
      if (!count)
        throw new AppException(
          CommerceErrorCode.PO_TRANSITION,
          'This order just changed. Reload.',
          HttpStatus.CONFLICT,
        );
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: `PURCHASE_ORDER_${to}`,
          entityType: 'PurchaseOrder',
          entityId: id,
          metadata: { supplierId: s.id, from: po.status },
        },
      });
    }, COMMERCE_TX);
    const owners = await this.prisma.userRole.findMany({
      where: { salonId: po.salonId, role: 'SALON_OWNER' },
      select: { userId: true },
    });
    for (const o of owners)
      await this.notifications.notify(
        o.userId,
        'owner.purchase_order.updated',
        {
          purchaseOrderId: id,
          number: po.number,
          status: to,
          supplierName: s.name,
        },
        `dashboard/salons/${po.salonId}/inventory/purchase-orders`,
      );
    const fresh = await this.prisma.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: poInclude,
    });
    return toPoDto(fresh);
  }
}
