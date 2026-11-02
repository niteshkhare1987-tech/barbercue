-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'PLACED', 'CONFIRMED', 'DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ListingChannel" AS ENUM ('SALON', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ENDED');

-- CreateEnum
CREATE TYPE "MarketOrderStatus" AS ENUM ('PLACED', 'ACCEPTED', 'READY_FOR_PICKUP', 'DISPATCHED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'RETURN_REQUESTED', 'RETURNED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "MarketPaymentMethod" AS ENUM ('PAY_AT_PICKUP', 'UPI_TO_SALON', 'INVOICE');

-- AlterTable
ALTER TABLE "inventory_suppliers" ADD COLUMN     "marketplaceSupplierId" TEXT;

-- CreateTable
CREATE TABLE "marketplace_suppliers" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "legalName" VARCHAR(160),
    "gstin" VARCHAR(15),
    "contactName" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "cityId" TEXT NOT NULL,
    "serviceCityIds" TEXT[],
    "defaultLeadTimeDays" INTEGER NOT NULL DEFAULT 3,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "freeDeliveryAbove" DECIMAL(10,2),
    "minimumOrderValue" DECIMAL(10,2),
    "status" "SupplierStatus" NOT NULL DEFAULT 'PENDING',
    "reviewNote" VARCHAR(300),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "marketplace_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_members" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offers" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "globalProductId" TEXT NOT NULL,
    "supplierSku" VARCHAR(60),
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "minOrderQuantity" INTEGER NOT NULL DEFAULT 1,
    "availableQuantity" INTEGER,
    "stockUpdatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leadTimeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "marketplaceSupplierId" TEXT,
    "inventorySupplierId" TEXT,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(500),
    "supplierNote" VARCHAR(300),
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryCharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3),
    "expectedDeliveryDate" DATE,
    "invoiceUrls" TEXT[],
    "createdByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMPTZ(6),
    "placedByUserId" TEXT,
    "confirmedAt" TIMESTAMPTZ(6),
    "dispatchedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "cancelReason" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "inventoryProductId" TEXT,
    "globalProductId" TEXT,
    "supplierOfferId" TEXT,
    "name" VARCHAR(160) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "receivedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "damagedQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "receivedByUserId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "note" VARCHAR(500),
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantityReceived" DECIMAL(12,3) NOT NULL,
    "quantityDamaged" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "batchNumber" VARCHAR(60),
    "expiryDate" DATE,
    "barcodeVerified" BOOLEAN,
    "discrepancyNote" VARCHAR(300),
    "movementId" TEXT,

    CONSTRAINT "goods_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_listings" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "inventoryProductId" TEXT NOT NULL,
    "channel" "ListingChannel" NOT NULL,
    "status" "ListingStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "title" VARCHAR(160) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "quantityListed" INTEGER NOT NULL,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "quantitySold" INTEGER NOT NULL DEFAULT 0,
    "batchNumber" VARCHAR(60),
    "expiryDate" DATE,
    "sealed" BOOLEAN NOT NULL DEFAULT true,
    "photoUrls" TEXT[],
    "invoiceUrl" VARCHAR(500),
    "provenanceNote" VARCHAR(300),
    "description" VARCHAR(500),
    "reviewNote" VARCHAR(300),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "market_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_orders" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "channel" "ListingChannel" NOT NULL,
    "status" "MarketOrderStatus" NOT NULL DEFAULT 'PLACED',
    "sellerSalonId" TEXT NOT NULL,
    "buyerUserId" TEXT NOT NULL,
    "buyerSalonId" TEXT,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3),
    "paymentMethod" "MarketPaymentMethod" NOT NULL,
    "paidAt" TIMESTAMPTZ(6),
    "pickupCode" VARCHAR(6),
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "note" VARCHAR(300),
    "expiresAt" TIMESTAMPTZ(6),
    "acceptedAt" TIMESTAMPTZ(6),
    "readyAt" TIMESTAMPTZ(6),
    "dispatchedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" VARCHAR(300),
    "returnReason" VARCHAR(300),
    "disputeReason" VARCHAR(500),
    "resolutionNote" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "market_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "sellerMovementId" TEXT,
    "buyerMovementId" TEXT,
    "returnMovementId" TEXT,

    CONSTRAINT "market_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_suppliers_status_idx" ON "marketplace_suppliers"("status");

-- CreateIndex
CREATE INDEX "supplier_members_userId_idx" ON "supplier_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_members_supplierId_userId_key" ON "supplier_members"("supplierId", "userId");

-- CreateIndex
CREATE INDEX "supplier_offers_globalProductId_isActive_idx" ON "supplier_offers"("globalProductId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_offers_supplierId_globalProductId_key" ON "supplier_offers"("supplierId", "globalProductId");

-- CreateIndex
CREATE INDEX "purchase_orders_marketplaceSupplierId_status_idx" ON "purchase_orders"("marketplaceSupplierId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_salonId_status_createdAt_idx" ON "purchase_orders"("salonId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_salonId_number_key" ON "purchase_orders"("salonId", "number");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchaseOrderId_idx" ON "purchase_order_items"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_salonId_idempotencyKey_key" ON "goods_receipts"("salonId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_lines_movementId_key" ON "goods_receipt_lines"("movementId");

-- CreateIndex
CREATE INDEX "market_listings_channel_status_idx" ON "market_listings"("channel", "status");

-- CreateIndex
CREATE INDEX "market_listings_salonId_status_idx" ON "market_listings"("salonId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "market_orders_number_key" ON "market_orders"("number");

-- CreateIndex
CREATE INDEX "market_orders_sellerSalonId_status_createdAt_idx" ON "market_orders"("sellerSalonId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "market_orders_buyerUserId_createdAt_idx" ON "market_orders"("buyerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "market_orders_status_expiresAt_idx" ON "market_orders"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "market_orders_buyerUserId_idempotencyKey_key" ON "market_orders"("buyerUserId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "market_order_items_sellerMovementId_key" ON "market_order_items"("sellerMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "market_order_items_buyerMovementId_key" ON "market_order_items"("buyerMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "market_order_items_returnMovementId_key" ON "market_order_items"("returnMovementId");

-- CreateIndex
CREATE INDEX "market_order_items_orderId_idx" ON "market_order_items"("orderId");

-- CreateIndex
CREATE INDEX "market_order_items_listingId_idx" ON "market_order_items"("listingId");

-- AddForeignKey
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_marketplaceSupplierId_fkey" FOREIGN KEY ("marketplaceSupplierId") REFERENCES "marketplace_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_suppliers" ADD CONSTRAINT "marketplace_suppliers_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_members" ADD CONSTRAINT "supplier_members_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "marketplace_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_members" ADD CONSTRAINT "supplier_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "marketplace_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_globalProductId_fkey" FOREIGN KEY ("globalProductId") REFERENCES "global_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_marketplaceSupplierId_fkey" FOREIGN KEY ("marketplaceSupplierId") REFERENCES "marketplace_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_inventorySupplierId_salonId_fkey" FOREIGN KEY ("inventorySupplierId", "salonId") REFERENCES "inventory_suppliers"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_inventoryProductId_salonId_fkey" FOREIGN KEY ("inventoryProductId", "salonId") REFERENCES "inventory_products"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_globalProductId_fkey" FOREIGN KEY ("globalProductId") REFERENCES "global_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "supplier_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_inventoryProductId_salonId_fkey" FOREIGN KEY ("inventoryProductId", "salonId") REFERENCES "inventory_products"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_sellerSalonId_fkey" FOREIGN KEY ("sellerSalonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_orders" ADD CONSTRAINT "market_orders_buyerSalonId_fkey" FOREIGN KEY ("buyerSalonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "market_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "market_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Inventory Phases 4-5 rules Prisma cannot express.

-- A listing can never promise more than it lists: reserved + sold stays within the listed quantity.
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_quantities_check" CHECK (
  "quantityListed" > 0 AND "quantityReserved" >= 0 AND "quantitySold" >= 0
  AND "quantityReserved" + "quantitySold" <= "quantityListed" AND "unitPrice" > 0
);
ALTER TABLE "market_order_items" ADD CONSTRAINT "market_order_items_quantity_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_quantities_check" CHECK (
  "quantity" > 0 AND "unitPrice" >= 0 AND "receivedQuantity" >= 0 AND "damagedQuantity" >= 0
);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_one_supplier_check" CHECK (
  ("marketplaceSupplierId" IS NULL) <> ("inventorySupplierId" IS NULL)
);
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_values_check" CHECK (
  "unitPrice" > 0 AND "minOrderQuantity" >= 1 AND ("availableQuantity" IS NULL OR "availableQuantity" >= 0)
);
