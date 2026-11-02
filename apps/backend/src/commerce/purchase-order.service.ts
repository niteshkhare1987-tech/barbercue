import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CommerceErrorCode,
  PO_RECEIVABLE,
  PO_TRANSITIONS,
  compareSuppliers,
  normalizeBarcode,
  type CancelInput,
  type CreatePurchaseOrderInput,
  type GoodsReceiptInput,
  type PurchaseOrderDto,
  type PurchaseOrderStatus,
  type SupplierComparisonDto,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { SalonAccessService } from '../common/salon-access/salon-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  COMMERCE_TX,
  ensureSalonProduct,
  money,
  nextPoNumber,
  piecesToStock,
  writeMovement,
} from './commerce-ledger';

export const poInclude = {
  salon: { select: { name: true } },
  marketplaceSupplier: { select: { id: true, name: true } },
  inventorySupplier: { select: { id: true, name: true } },
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      globalProduct: {
        select: { barcodes: { take: 1, select: { display: true } } },
      },
    },
  },
  receipts: {
    orderBy: { receivedAt: 'asc' as const },
    include: { lines: true },
  },
} satisfies Prisma.PurchaseOrderInclude;
type PoRow = Prisma.PurchaseOrderGetPayload<{ include: typeof poInclude }>;

export function toPoDto(po: PoRow): PurchaseOrderDto {
  return {
    id: po.id,
    number: po.number,
    salonId: po.salonId,
    salonName: po.salon.name,
    status: po.status,
    supplier: po.marketplaceSupplier
      ? {
          kind: 'MARKETPLACE',
          id: po.marketplaceSupplier.id,
          name: po.marketplaceSupplier.name,
        }
      : {
          kind: 'OWN',
          id: po.inventorySupplier!.id,
          name: po.inventorySupplier!.name,
        },
    notes: po.notes,
    supplierNote: po.supplierNote,
    subtotal: money(po.subtotal),
    deliveryCharge: money(po.deliveryCharge),
    total: money(po.total),
    currency: po.currency,
    expectedDeliveryDate:
      po.expectedDeliveryDate?.toISOString().slice(0, 10) ?? null,
    invoiceUrls: po.invoiceUrls,
    items: po.items.map((i) => ({
      id: i.id,
      inventoryProductId: i.inventoryProductId,
      globalProductId: i.globalProductId,
      name: i.name,
      barcode: i.globalProduct?.barcodes[0]?.display ?? null,
      quantity: i.quantity.toFixed(3),
      unitPrice: money(i.unitPrice),
      receivedQuantity: i.receivedQuantity.toFixed(3),
      damagedQuantity: i.damagedQuantity.toFixed(3),
    })),
    receipts: po.receipts.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt.toISOString(),
      note: r.note,
      lines: r.lines.map((l) => ({
        purchaseOrderItemId: l.purchaseOrderItemId,
        quantityReceived: l.quantityReceived.toFixed(3),
        quantityDamaged: l.quantityDamaged.toFixed(3),
        batchNumber: l.batchNumber,
        expiryDate: l.expiryDate?.toISOString().slice(0, 10) ?? null,
        barcodeVerified: l.barcodeVerified,
        discrepancyNote: l.discrepancyNote,
      })),
    })),
    placedAt: po.placedAt?.toISOString() ?? null,
    cancelReason: po.cancelReason,
    createdAt: po.createdAt.toISOString(),
  };
}

const conflict = (
  message: string,
  code: string = CommerceErrorCode.PO_TRANSITION,
) => new AppException(code, message, HttpStatus.CONFLICT);
const bad = (message: string, code: string = CommerceErrorCode.PO_INVALID) =>
  new AppException(code, message, HttpStatus.BAD_REQUEST);

/**
 * Inventory Phase 4 — the salon side of purchasing: compare approved suppliers for a product,
 * draft and place purchase orders (to a FastQue supplier or one of the salon's own suppliers),
 * cancel, and receive deliveries. Placing never changes stock: only a goods receipt does, one
 * PURCHASE ledger entry per good line, with batch/expiry and a barcode check; damaged quantities
 * and discrepancies are recorded but not added to stock.
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly salonAccess: SalonAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async compare(
    userId: string,
    salonId: string,
    globalProductId: string,
    quantity: number,
  ): Promise<SupplierComparisonDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const [salon, product, offers] = await Promise.all([
      this.prisma.salon.findUniqueOrThrow({
        where: { id: salonId },
        select: { cityId: true },
      }),
      this.prisma.globalProduct.findUnique({
        where: { id: globalProductId },
        select: { name: true },
      }),
      this.prisma.supplierOffer.findMany({
        where: {
          globalProductId,
          isActive: true,
          supplier: { status: 'APPROVED' },
        },
        include: { supplier: true },
      }),
    ]);
    if (!product)
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Product not found.',
        HttpStatus.NOT_FOUND,
      );
    const quotes = compareSuppliers(
      quantity,
      offers.map((o) => ({
        supplierId: o.supplierId,
        supplierName: o.supplier.name,
        unitPrice: Number(o.unitPrice),
        minOrderQuantity: o.minOrderQuantity,
        availableQuantity: o.availableQuantity,
        leadTimeDays: o.leadTimeDays ?? o.supplier.defaultLeadTimeDays,
        deliveryCharge: Number(o.supplier.deliveryCharge),
        freeDeliveryAbove:
          o.supplier.freeDeliveryAbove != null
            ? Number(o.supplier.freeDeliveryAbove)
            : null,
      })),
    ).map((q) => {
      const o = offers.find((x) => x.supplierId === q.supplierId)!;
      return {
        ...q,
        offerId: o.id,
        deliversToShopCity: o.supplier.serviceCityIds.includes(salon.cityId),
        stockUpdatedAt: o.stockUpdatedAt.toISOString(),
      };
    });
    // Suppliers delivering to the shop's city first.
    quotes.sort(
      (a, b) => Number(b.deliversToShopCity) - Number(a.deliversToShopCity),
    );
    return { globalProductId, productName: product.name, quantity, quotes };
  }

  async list(userId: string, salonId: string): Promise<PurchaseOrderDto[]> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { salonId },
      include: poInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toPoDto);
  }

  async get(
    userId: string,
    salonId: string,
    id: string,
  ): Promise<PurchaseOrderDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    return toPoDto(await this.load(salonId, id));
  }

  private async load(salonId: string, id: string): Promise<PoRow> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, salonId },
      include: poInclude,
    });
    if (!po)
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Purchase order not found.',
        HttpStatus.NOT_FOUND,
      );
    return po;
  }

  /** A draft. Marketplace orders use the supplier's current prices; own-supplier orders the given ones. */
  async create(
    userId: string,
    salonId: string,
    input: CreatePurchaseOrderInput,
  ): Promise<PurchaseOrderDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUniqueOrThrow({
      where: { id: salonId },
      select: { currency: true },
    });
    let items: Prisma.PurchaseOrderItemUncheckedCreateWithoutPurchaseOrderInput[];
    let deliveryCharge = new Prisma.Decimal(0);
    if (input.marketplaceSupplierId) {
      const supplier = await this.prisma.marketplaceSupplier.findFirst({
        where: { id: input.marketplaceSupplierId, status: 'APPROVED' },
      });
      if (!supplier)
        throw bad(
          'That supplier is not available on FastQue.',
          CommerceErrorCode.SUPPLIER_NOT_APPROVED,
        );
      const ids = input.items.map((i) => i.globalProductId);
      if (ids.some((id) => !id))
        throw bad('Choose catalog products for a FastQue supplier.');
      const offers = await this.prisma.supplierOffer.findMany({
        where: {
          supplierId: supplier.id,
          globalProductId: { in: ids as string[] },
          isActive: true,
        },
        include: { globalProduct: { select: { name: true } } },
      });
      items = input.items.map((i) => {
        const offer = offers.find(
          (o) => o.globalProductId === i.globalProductId,
        );
        if (!offer)
          throw bad('The supplier no longer sells one of these products.');
        if (!Number.isInteger(i.quantity))
          throw bad('Order whole pieces from a FastQue supplier.');
        if (i.quantity < offer.minOrderQuantity)
          throw bad(
            `${offer.globalProduct.name}: the minimum order is ${offer.minOrderQuantity}.`,
          );
        return {
          salonId,
          globalProductId: offer.globalProductId,
          supplierOfferId: offer.id,
          name: offer.globalProduct.name,
          quantity: new Prisma.Decimal(i.quantity),
          unitPrice: offer.unitPrice,
        };
      });
      const subtotal = items.reduce(
        (a, i) =>
          a.plus(
            new Prisma.Decimal(i.quantity as Prisma.Decimal).times(
              i.unitPrice as Prisma.Decimal,
            ),
          ),
        new Prisma.Decimal(0),
      );
      if (
        supplier.minimumOrderValue &&
        subtotal.lessThan(supplier.minimumOrderValue)
      )
        throw bad(
          `${supplier.name}'s minimum order is ${money(supplier.minimumOrderValue)}.`,
        );
      deliveryCharge =
        supplier.freeDeliveryAbove &&
        subtotal.greaterThanOrEqualTo(supplier.freeDeliveryAbove)
          ? new Prisma.Decimal(0)
          : supplier.deliveryCharge;
    } else {
      const own = await this.prisma.inventorySupplier.findFirst({
        where: { id: input.inventorySupplierId!, salonId },
      });
      if (!own) throw bad('That supplier was not found in this shop.');
      const productIds = input.items.map((i) => i.inventoryProductId);
      if (productIds.some((id) => !id))
        throw bad('Choose your own products for your own supplier.');
      const products = await this.prisma.inventoryProduct.findMany({
        where: { salonId, id: { in: productIds as string[] }, isActive: true },
        select: { id: true, name: true, globalProductId: true },
      });
      items = input.items.map((i) => {
        const p = products.find((x) => x.id === i.inventoryProductId);
        if (!p) throw bad('One of the products is not active in this shop.');
        return {
          salonId,
          inventoryProductId: p.id,
          globalProductId: p.globalProductId,
          name: p.name,
          quantity: new Prisma.Decimal(i.quantity.toFixed(3)),
          unitPrice: new Prisma.Decimal(i.unitPrice.toFixed(2)),
        };
      });
    }
    const subtotal = items.reduce(
      (a, i) =>
        a.plus(
          new Prisma.Decimal(i.quantity as Prisma.Decimal).times(
            i.unitPrice as Prisma.Decimal,
          ),
        ),
      new Prisma.Decimal(0),
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        const po = await this.prisma.$transaction(async (tx) => {
          const created = await tx.purchaseOrder.create({
            data: {
              salonId,
              number: await nextPoNumber(tx, salonId),
              marketplaceSupplierId: input.marketplaceSupplierId ?? null,
              inventorySupplierId: input.inventorySupplierId ?? null,
              notes: input.notes?.trim() || null,
              subtotal,
              deliveryCharge,
              total: subtotal.plus(deliveryCharge),
              currency: salon.currency ?? 'INR',
              createdByUserId: userId,
              items: { create: items },
            },
            include: poInclude,
          });
          await tx.auditLog.create({
            data: {
              actorUserId: userId,
              action: 'PURCHASE_ORDER_CREATED',
              entityType: 'PurchaseOrder',
              entityId: created.id,
              metadata: { salonId, total: created.total.toFixed(2) },
            },
          });
          return created;
        }, COMMERCE_TX);
        return toPoDto(po);
      } catch (error) {
        if (
          attempt < 3 &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          continue;
        throw error;
      }
    }
  }

  private async move(
    userId: string,
    salonId: string,
    id: string,
    to: PurchaseOrderStatus,
    data: Prisma.PurchaseOrderUpdateManyMutationInput,
  ): Promise<PoRow> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const po = await this.load(salonId, id);
    if (!PO_TRANSITIONS.SALON[po.status]?.includes(to))
      throw conflict(
        `This order is ${po.status.toLowerCase().replace('_', ' ')} and can't be changed that way.`,
      );
    const { count } = await this.prisma.purchaseOrder.updateMany({
      where: { id, salonId, status: po.status },
      data: { status: to, ...data },
    });
    if (count === 0)
      throw conflict('This order just changed. Reload and try again.');
    await this.prisma.auditLog.create({
      data: {
        actorUserId: userId,
        action: `PURCHASE_ORDER_${to}`,
        entityType: 'PurchaseOrder',
        entityId: id,
        metadata: { salonId, from: po.status },
      },
    });
    return this.load(salonId, id);
  }

  /** Owner approval: the draft goes to the supplier (in-app only for FastQue suppliers). */
  async place(
    userId: string,
    salonId: string,
    id: string,
  ): Promise<PurchaseOrderDto> {
    const po = await this.move(userId, salonId, id, 'PLACED', {
      placedAt: new Date(),
      placedByUserId: userId,
    });
    if (po.marketplaceSupplierId) {
      const members = await this.prisma.supplierMember.findMany({
        where: { supplierId: po.marketplaceSupplierId },
        select: { userId: true },
      });
      for (const m of members)
        await this.notifications.notify(
          m.userId,
          'supplier.purchase_order.placed',
          {
            purchaseOrderId: po.id,
            number: po.number,
            salonName: po.salon.name,
          },
          `supplier/orders/${po.id}`,
        );
    }
    return toPoDto(po);
  }

  async cancel(
    userId: string,
    salonId: string,
    id: string,
    input: CancelInput,
  ): Promise<PurchaseOrderDto> {
    const po = await this.move(userId, salonId, id, 'CANCELLED', {
      cancelReason: input.reason.trim(),
      closedAt: new Date(),
    });
    return toPoDto(po);
  }

  async addInvoice(
    userId: string,
    salonId: string,
    id: string,
    url: string,
  ): Promise<PurchaseOrderDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const po = await this.load(salonId, id);
    if (po.invoiceUrls.length >= 10) throw bad('At most 10 invoice photos.');
    await this.prisma.purchaseOrder.update({
      where: { id },
      data: { invoiceUrls: { push: url } },
    });
    return toPoDto(await this.load(salonId, id));
  }

  /**
   * Checks in a delivery. Each line: good quantity → a PURCHASE ledger entry at the order price
   * (into the matching product, created from the catalog if new), damaged quantity recorded only.
   * The scanned barcode is checked against the ordered product. Retry-safe via the receipt key.
   */
  async receive(
    userId: string,
    salonId: string,
    id: string,
    idempotencyKey: string | undefined,
    input: GoodsReceiptInput,
  ): Promise<PurchaseOrderDto> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const key = idempotencyKey?.trim();
    if (!key)
      throw bad(
        'An Idempotency-Key header is required.',
        CommerceErrorCode.RECEIPT_INVALID,
      );
    const po = await this.load(salonId, id);
    const earlier = await this.prisma.goodsReceipt.findUnique({
      where: { salonId_idempotencyKey: { salonId, idempotencyKey: key } },
    });
    if (earlier) return toPoDto(po);
    if (!PO_RECEIVABLE.includes(po.status))
      throw conflict(`A ${po.status.toLowerCase()} order can't be received.`);
    const lines = input.lines.filter(
      (l) => l.quantityReceived > 0 || l.quantityDamaged > 0,
    );
    if (!lines.length)
      throw bad('Enter what arrived.', CommerceErrorCode.RECEIPT_INVALID);

    const supplierId = po.marketplaceSupplierId
      ? await this.linkedSalonSupplier(salonId, po.marketplaceSupplierId)
      : po.inventorySupplierId;

    await this.prisma.$transaction(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          purchaseOrderId: po.id,
          salonId,
          receivedByUserId: userId,
          idempotencyKey: key,
          note: input.note?.trim() || null,
        },
      });
      for (const [index, line] of lines.entries()) {
        const item = po.items.find((i) => i.id === line.purchaseOrderItemId);
        if (!item)
          throw bad(
            'A line does not belong to this order.',
            CommerceErrorCode.RECEIPT_INVALID,
          );
        // Barcode check: the delivered goods must be the ordered catalog product.
        let barcodeVerified: boolean | null = null;
        if (line.scannedBarcode && item.globalProductId) {
          const n = normalizeBarcode(line.scannedBarcode);
          const hit = n.ok
            ? await tx.globalProductBarcode.findUnique({
                where: { code: n.code },
                select: { productId: true },
              })
            : null;
          barcodeVerified = hit?.productId === item.globalProductId;
          if (!barcodeVerified)
            throw bad(
              `${item.name}: the scanned barcode is a different product. Don't receive it against this line.`,
              CommerceErrorCode.RECEIPT_INVALID,
            );
        }
        let movementId: string | null = null;
        if (line.quantityReceived > 0) {
          const product = item.inventoryProductId
            ? await tx.inventoryProduct.findUniqueOrThrow({
                where: { id: item.inventoryProductId },
                select: { id: true, unit: true },
              })
            : await ensureSalonProduct(
                tx,
                salonId,
                item.globalProductId!,
                'PROFESSIONAL',
              );
          // Own-supplier lines are in the product's unit; FastQue lines are pieces.
          const stockQty = item.inventoryProductId
            ? new Prisma.Decimal(line.quantityReceived.toFixed(3))
            : await piecesToStock(
                tx,
                line.quantityReceived,
                product,
                item.globalProductId,
              );
          const unitCost = item.inventoryProductId
            ? item.unitPrice
            : item.unitPrice
                .times(line.quantityReceived)
                .dividedBy(stockQty)
                .toDecimalPlaces(2);
          movementId = await writeMovement(tx, {
            salonId,
            productId: product.id,
            actorUserId: userId,
            kind: 'PURCHASE',
            quantityDelta: stockQty,
            unitCost,
            supplierId,
            reason: `Received on ${po.number}`,
            reference: `po:${po.number}`,
            batchNumber: line.batchNumber?.trim() || null,
            expiryDate: line.expiryDate
              ? new Date(`${line.expiryDate}T00:00:00.000Z`)
              : null,
            key: `po-receipt:${receipt.id}:${index}`,
          });
          if (!item.inventoryProductId)
            await tx.purchaseOrderItem.update({
              where: { id: item.id },
              data: { inventoryProductId: product.id },
            });
        }
        await tx.goodsReceiptLine.create({
          data: {
            receiptId: receipt.id,
            purchaseOrderItemId: item.id,
            quantityReceived: new Prisma.Decimal(
              line.quantityReceived.toFixed(3),
            ),
            quantityDamaged: new Prisma.Decimal(
              line.quantityDamaged.toFixed(3),
            ),
            batchNumber: line.batchNumber?.trim() || null,
            expiryDate: line.expiryDate
              ? new Date(`${line.expiryDate}T00:00:00.000Z`)
              : null,
            barcodeVerified,
            discrepancyNote: line.discrepancyNote?.trim() || null,
            movementId,
          },
        });
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            receivedQuantity: { increment: line.quantityReceived },
            damagedQuantity: { increment: line.quantityDamaged },
          },
        });
      }
      const items = await tx.purchaseOrderItem.findMany({
        where: { purchaseOrderId: po.id },
      });
      const complete = items.every((i) =>
        i.receivedQuantity
          .plus(i.damagedQuantity)
          .greaterThanOrEqualTo(i.quantity),
      );
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          ...(complete ? { closedAt: new Date() } : {}),
          ...(input.invoiceUrl
            ? { invoiceUrls: { push: input.invoiceUrl } }
            : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'PURCHASE_ORDER_RECEIVED',
          entityType: 'PurchaseOrder',
          entityId: po.id,
          metadata: {
            salonId,
            receiptId: receipt.id,
            complete,
            lines: lines.length,
          },
        },
      });
    }, COMMERCE_TX);
    return toPoDto(await this.load(salonId, id));
  }

  /** The salon's own supplier record for a FastQue supplier (created and linked on first use). */
  private async linkedSalonSupplier(
    salonId: string,
    marketplaceSupplierId: string,
  ): Promise<string> {
    const linked = await this.prisma.inventorySupplier.findFirst({
      where: { salonId, marketplaceSupplierId },
      select: { id: true },
    });
    if (linked) return linked.id;
    const m = await this.prisma.marketplaceSupplier.findUniqueOrThrow({
      where: { id: marketplaceSupplierId },
    });
    const normalizedName = m.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const same = await this.prisma.inventorySupplier.findFirst({
      where: { salonId, normalizedName },
    });
    if (same) {
      await this.prisma.inventorySupplier.update({
        where: { id: same.id },
        data: { marketplaceSupplierId },
      });
      return same.id;
    }
    const created = await this.prisma.inventorySupplier.create({
      data: {
        salonId,
        name: m.name,
        normalizedName,
        contactName: m.contactName,
        phone: m.phone,
        email: m.email,
        leadTimeDays: m.defaultLeadTimeDays,
        marketplaceSupplierId,
      },
    });
    return created.id;
  }

  /** "My existing supplier is on FastQue now": link the salon's supplier to the marketplace one. */
  async linkSupplier(
    userId: string,
    salonId: string,
    inventorySupplierId: string,
    marketplaceSupplierId: string | null,
  ): Promise<{ id: string; marketplaceSupplierId: string | null }> {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    if (marketplaceSupplierId) {
      const ok = await this.prisma.marketplaceSupplier.count({
        where: { id: marketplaceSupplierId, status: 'APPROVED' },
      });
      if (!ok)
        throw bad(
          'That FastQue supplier is not available.',
          CommerceErrorCode.SUPPLIER_NOT_APPROVED,
        );
    }
    const { count } = await this.prisma.inventorySupplier.updateMany({
      where: { id: inventorySupplierId, salonId },
      data: { marketplaceSupplierId },
    });
    if (!count)
      throw new AppException(
        CommerceErrorCode.NOT_FOUND,
        'Supplier not found.',
        HttpStatus.NOT_FOUND,
      );
    return { id: inventorySupplierId, marketplaceSupplierId };
  }

  /** Approved FastQue suppliers delivering to this shop's city (for picking a supplier). */
  async marketplaceSuppliers(userId: string, salonId: string) {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const salon = await this.prisma.salon.findUniqueOrThrow({
      where: { id: salonId },
      select: { cityId: true },
    });
    const rows = await this.prisma.marketplaceSupplier.findMany({
      where: { status: 'APPROVED' },
      select: {
        id: true,
        name: true,
        serviceCityIds: true,
        defaultLeadTimeDays: true,
        deliveryCharge: true,
        freeDeliveryAbove: true,
        minimumOrderValue: true,
        _count: { select: { offers: { where: { isActive: true } } } },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      deliversToShopCity: r.serviceCityIds.includes(salon.cityId),
      defaultLeadTimeDays: r.defaultLeadTimeDays,
      deliveryCharge: money(r.deliveryCharge),
      freeDeliveryAbove: r.freeDeliveryAbove
        ? money(r.freeDeliveryAbove)
        : null,
      minimumOrderValue: r.minimumOrderValue
        ? money(r.minimumOrderValue)
        : null,
      offerCount: r._count.offers,
    }));
  }

  /** A FastQue supplier's active price list (for building an order). */
  async supplierCatalog(userId: string, salonId: string, supplierId: string) {
    await this.salonAccess.assertOwnerOrAdminAccess(userId, salonId);
    const offers = await this.prisma.supplierOffer.findMany({
      where: { supplierId, isActive: true, supplier: { status: 'APPROVED' } },
      include: {
        globalProduct: {
          select: {
            name: true,
            brand: true,
            barcodes: { take: 1, select: { display: true } },
            images: {
              take: 1,
              orderBy: { sortOrder: 'asc' },
              select: { url: true },
            },
          },
        },
      },
      orderBy: { globalProduct: { normalizedName: 'asc' } },
      take: 500,
    });
    return offers.map((o) => ({
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
    }));
  }
}
