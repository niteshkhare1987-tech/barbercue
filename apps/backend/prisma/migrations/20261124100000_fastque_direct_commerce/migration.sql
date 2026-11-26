-- CreateEnum
CREATE TYPE "CommerceSellerType" AS ENUM ('FASTQUE', 'SALON', 'DISTRIBUTOR', 'MANUFACTURER', 'BRAND', 'WHOLESALER');

-- CreateEnum
CREATE TYPE "CommerceListingStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "CommerceOrderStatus" AS ENUM ('PLACED', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'DELIVERY_FAILED', 'RETURN_TO_ORIGIN', 'RETURNED');

-- CreateEnum
CREATE TYPE "CommercePaymentStatus" AS ENUM ('COD_PENDING', 'COD_COLLECTED', 'SETTLEMENT_PENDING', 'PARTIALLY_SETTLED', 'RECONCILED', 'REFUND_PENDING', 'REFUNDED_OFFLINE', 'VOID');

-- CreateEnum
CREATE TYPE "CommerceMovementKind" AS ENUM ('OPENING', 'PURCHASE', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'DISPATCH', 'DAMAGE', 'EXPIRE', 'QUARANTINE_IN', 'QUARANTINE_OUT', 'TRANSFER_OUT', 'TRANSFER_IN');

-- CreateEnum
CREATE TYPE "CommerceReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'REPLACED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CommercePoStatus" AS ENUM ('DRAFT', 'APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "commerce_sellers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "type" "CommerceSellerType" NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "legalName" VARCHAR(160),
    "gstin" VARCHAR(15),
    "address" VARCHAR(400),
    "supportEmail" VARCHAR(254),
    "supportPhone" VARCHAR(20),
    "grievance" VARCHAR(400),
    "returnPolicy" VARCHAR(2000),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "salonId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_sellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_staff_grants" (
    "userId" TEXT NOT NULL,
    "permission" VARCHAR(30) NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_staff_grants_pkey" PRIMARY KEY ("userId","permission")
);

-- CreateTable
CREATE TABLE "commerce_warehouses" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "address" VARCHAR(400),
    "city" VARCHAR(80),
    "state" VARCHAR(80),
    "pincode" VARCHAR(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_listings" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "globalProductId" TEXT NOT NULL,
    "sku" VARCHAR(60) NOT NULL,
    "mrp" DECIMAL(12,2) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "promoPrice" DECIMAL(12,2),
    "promoStartsAt" TIMESTAMPTZ(6),
    "promoEndsAt" TIMESTAMPTZ(6),
    "status" "CommerceListingStatus" NOT NULL DEFAULT 'DRAFT',
    "maxPerOrder" INTEGER NOT NULL DEFAULT 5,
    "weightGrams" INTEGER NOT NULL DEFAULT 500,
    "codEligible" BOOLEAN NOT NULL DEFAULT true,
    "returnable" BOOLEAN NOT NULL DEFAULT true,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 7,
    "reorderLevel" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "expiryTracked" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_batches" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "batchNumber" VARCHAR(60) NOT NULL,
    "manufacturedOn" DATE,
    "expiresOn" DATE,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "supplierId" UUID,
    "purchaseOrderId" UUID,
    "storageLocation" VARCHAR(60),
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_stock_movements" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "kind" "CommerceMovementKind" NOT NULL,
    "onHandDelta" INTEGER NOT NULL DEFAULT 0,
    "reservedDelta" INTEGER NOT NULL DEFAULT 0,
    "quarantineDelta" INTEGER NOT NULL DEFAULT 0,
    "damagedDelta" INTEGER NOT NULL DEFAULT 0,
    "expiredDelta" INTEGER NOT NULL DEFAULT 0,
    "reference" VARCHAR(80),
    "note" VARCHAR(300),
    "actorUserId" TEXT,
    "idempotencyKey" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_zones" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "deliveryCharge" DECIMAL(12,2) NOT NULL,
    "freeAbove" DECIMAL(12,2),
    "minDays" INTEGER NOT NULL,
    "maxDays" INTEGER NOT NULL,
    "codEligible" BOOLEAN NOT NULL DEFAULT true,
    "maxCodAmount" DECIMAL(12,2),
    "minOrderAmount" DECIMAL(12,2),
    "maxWeightGrams" INTEGER,
    "pinRules" TEXT[],
    "blockedPins" TEXT[],
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_addresses" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "label" VARCHAR(40),
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "line1" VARCHAR(160) NOT NULL,
    "line2" VARCHAR(160),
    "landmark" VARCHAR(120),
    "city" VARCHAR(80) NOT NULL,
    "state" VARCHAR(80) NOT NULL,
    "pincode" VARCHAR(6) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_checkouts" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "customerUserId" TEXT,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_orders" (
    "id" UUID NOT NULL,
    "orderNumber" VARCHAR(20) NOT NULL,
    "checkoutId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "sellerName" VARCHAR(120) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "customerUserId" TEXT,
    "contactName" VARCHAR(120) NOT NULL,
    "contactPhone" VARCHAR(20) NOT NULL,
    "contactEmail" VARCHAR(254),
    "shippingAddress" JSONB NOT NULL,
    "billingAddress" JSONB,
    "instructions" VARCHAR(300),
    "accessTokenHash" VARCHAR(64) NOT NULL,
    "status" "CommerceOrderStatus" NOT NULL DEFAULT 'PLACED',
    "paymentMethod" VARCHAR(20) NOT NULL DEFAULT 'COD',
    "paymentStatus" "CommercePaymentStatus" NOT NULL DEFAULT 'COD_PENDING',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryCharge" DECIMAL(12,2) NOT NULL,
    "taxIncluded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "couponCode" VARCHAR(30),
    "minDays" INTEGER NOT NULL,
    "maxDays" INTEGER NOT NULL,
    "placedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" VARCHAR(300),
    "packagingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "internalNote" VARCHAR(1000),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_items" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "globalProductId" TEXT NOT NULL,
    "sku" VARCHAR(60) NOT NULL,
    "productName" VARCHAR(160) NOT NULL,
    "brand" VARCHAR(120),
    "category" VARCHAR(80),
    "variant" VARCHAR(80),
    "barcode" VARCHAR(64),
    "hsnCode" VARCHAR(8),
    "gstRatePercent" DECIMAL(5,2),
    "quantity" INTEGER NOT NULL,
    "mrp" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "costTotal" DECIMAL(12,2) NOT NULL,
    "returnable" BOOLEAN NOT NULL,
    "returnWindowDays" INTEGER NOT NULL,

    CONSTRAINT "commerce_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_allocations" (
    "id" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "state" VARCHAR(12) NOT NULL DEFAULT 'RESERVED',

    CONSTRAINT "commerce_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_events" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "CommerceOrderStatus",
    "toStatus" "CommerceOrderStatus" NOT NULL,
    "actorKind" VARCHAR(12) NOT NULL,
    "actorUserId" TEXT,
    "note" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_shipments" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "courier" VARCHAR(80) NOT NULL,
    "trackingNumber" VARCHAR(80),
    "trackingUrl" VARCHAR(500),
    "weightGrams" INTEGER,
    "courierCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "codFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expectedOn" DATE,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "proofNote" VARCHAR(300),
    "manual" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_cod_entries" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reference" VARCHAR(80),
    "occurredOn" DATE NOT NULL,
    "note" VARCHAR(300),
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_cod_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_returns" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "orderId" UUID NOT NULL,
    "resolution" VARCHAR(12) NOT NULL,
    "reason" VARCHAR(30) NOT NULL,
    "details" VARCHAR(1000),
    "status" "CommerceReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "adminNote" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_return_items" (
    "id" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "disposition" VARCHAR(10),

    CONSTRAINT "commerce_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_coupons" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "description" VARCHAR(200),
    "kind" VARCHAR(15) NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "maxDiscount" DECIMAL(12,2),
    "minOrder" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "brand" VARCHAR(120),
    "category" VARCHAR(80),
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "usageLimit" INTEGER,
    "perCustomer" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_coupon_uses" (
    "id" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "released" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "commerce_coupon_uses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_suppliers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "contactName" VARCHAR(120),
    "phone" VARCHAR(20),
    "email" VARCHAR(254),
    "gstin" VARCHAR(15),
    "address" VARCHAR(400),
    "brands" TEXT[],
    "creditDays" INTEGER NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_supplier_products" (
    "supplierId" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_supplier_products_pkey" PRIMARY KEY ("supplierId","listingId")
);

-- CreateTable
CREATE TABLE "commerce_purchase_orders" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "supplierId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" "CommercePoStatus" NOT NULL DEFAULT 'DRAFT',
    "invoiceNumber" VARCHAR(60),
    "expectedOn" DATE,
    "note" VARCHAR(500),
    "createdByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "orderedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_po_items" (
    "id" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commerce_po_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_supplier_payments" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "poId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "reference" VARCHAR(80),
    "actorUserId" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_outbox" (
    "id" UUID NOT NULL,
    "dedupeKey" VARCHAR(160) NOT NULL,
    "userId" TEXT NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "payload" JSONB,
    "deepLink" VARCHAR(300),
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(300),
    "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_sellers_code_key" ON "commerce_sellers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_sellers_salonId_key" ON "commerce_sellers"("salonId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_warehouses_code_key" ON "commerce_warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_listings_sku_key" ON "commerce_listings"("sku");

-- CreateIndex
CREATE INDEX "commerce_listings_status_createdAt_idx" ON "commerce_listings"("status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_listings_globalProductId_status_idx" ON "commerce_listings"("globalProductId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_listings_sellerId_globalProductId_key" ON "commerce_listings"("sellerId", "globalProductId");

-- CreateIndex
CREATE INDEX "commerce_batches_listingId_expiresOn_idx" ON "commerce_batches"("listingId", "expiresOn");

-- CreateIndex
CREATE INDEX "commerce_batches_warehouseId_idx" ON "commerce_batches"("warehouseId");

-- CreateIndex
CREATE INDEX "commerce_batches_expiresOn_idx" ON "commerce_batches"("expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_batches_listingId_warehouseId_batchNumber_key" ON "commerce_batches"("listingId", "warehouseId", "batchNumber");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_stock_movements_idempotencyKey_key" ON "commerce_stock_movements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "commerce_stock_movements_batchId_createdAt_idx" ON "commerce_stock_movements"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_stock_movements_reference_idx" ON "commerce_stock_movements"("reference");

-- CreateIndex
CREATE INDEX "commerce_stock_movements_kind_createdAt_idx" ON "commerce_stock_movements"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_zones_isActive_priority_idx" ON "commerce_zones"("isActive", "priority");

-- CreateIndex
CREATE INDEX "commerce_addresses_userId_idx" ON "commerce_addresses"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkouts_number_key" ON "commerce_checkouts"("number");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_checkouts_idempotencyKey_key" ON "commerce_checkouts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "commerce_checkouts_customerUserId_createdAt_idx" ON "commerce_checkouts"("customerUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_orderNumber_key" ON "commerce_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "commerce_orders_status_placedAt_idx" ON "commerce_orders"("status", "placedAt");

-- CreateIndex
CREATE INDEX "commerce_orders_paymentStatus_idx" ON "commerce_orders"("paymentStatus");

-- CreateIndex
CREATE INDEX "commerce_orders_customerUserId_placedAt_idx" ON "commerce_orders"("customerUserId", "placedAt");

-- CreateIndex
CREATE INDEX "commerce_orders_contactPhone_placedAt_idx" ON "commerce_orders"("contactPhone", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_one_per_checkout" ON "commerce_orders"("checkoutId", "sellerId");

-- CreateIndex
CREATE INDEX "commerce_order_items_orderId_idx" ON "commerce_order_items"("orderId");

-- CreateIndex
CREATE INDEX "commerce_order_items_listingId_idx" ON "commerce_order_items"("listingId");

-- CreateIndex
CREATE INDEX "commerce_allocations_orderItemId_idx" ON "commerce_allocations"("orderItemId");

-- CreateIndex
CREATE INDEX "commerce_allocations_batchId_state_idx" ON "commerce_allocations"("batchId", "state");

-- CreateIndex
CREATE INDEX "commerce_order_events_orderId_createdAt_idx" ON "commerce_order_events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_shipments_orderId_idx" ON "commerce_shipments"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_cod_entries_idempotencyKey_key" ON "commerce_cod_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "commerce_cod_entries_orderId_kind_idx" ON "commerce_cod_entries"("orderId", "kind");

-- CreateIndex
CREATE INDEX "commerce_cod_entries_kind_occurredOn_idx" ON "commerce_cod_entries"("kind", "occurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_returns_number_key" ON "commerce_returns"("number");

-- CreateIndex
CREATE INDEX "commerce_returns_orderId_idx" ON "commerce_returns"("orderId");

-- CreateIndex
CREATE INDEX "commerce_returns_status_createdAt_idx" ON "commerce_returns"("status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_return_items_returnId_idx" ON "commerce_return_items"("returnId");

-- CreateIndex
CREATE INDEX "commerce_return_items_orderItemId_idx" ON "commerce_return_items"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_coupons_code_key" ON "commerce_coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_coupon_uses_orderId_key" ON "commerce_coupon_uses"("orderId");

-- CreateIndex
CREATE INDEX "commerce_coupon_uses_couponId_phone_idx" ON "commerce_coupon_uses"("couponId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_suppliers_name_key" ON "commerce_suppliers"("name");

-- CreateIndex
CREATE INDEX "commerce_supplier_products_listingId_idx" ON "commerce_supplier_products"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_purchase_orders_number_key" ON "commerce_purchase_orders"("number");

-- CreateIndex
CREATE INDEX "commerce_purchase_orders_status_createdAt_idx" ON "commerce_purchase_orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_purchase_orders_supplierId_idx" ON "commerce_purchase_orders"("supplierId");

-- CreateIndex
CREATE INDEX "commerce_po_items_poId_idx" ON "commerce_po_items"("poId");

-- CreateIndex
CREATE INDEX "commerce_po_items_listingId_idx" ON "commerce_po_items"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_supplier_payments_idempotencyKey_key" ON "commerce_supplier_payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "commerce_supplier_payments_supplierId_idx" ON "commerce_supplier_payments"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_outbox_dedupeKey_key" ON "commerce_outbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "commerce_outbox_status_nextAttemptAt_idx" ON "commerce_outbox"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "commerce_listings" ADD CONSTRAINT "commerce_listings_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "commerce_sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_listings" ADD CONSTRAINT "commerce_listings_globalProductId_fkey" FOREIGN KEY ("globalProductId") REFERENCES "global_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_batches" ADD CONSTRAINT "commerce_batches_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "commerce_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_batches" ADD CONSTRAINT "commerce_batches_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "commerce_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_stock_movements" ADD CONSTRAINT "commerce_stock_movements_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "commerce_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_zones" ADD CONSTRAINT "commerce_zones_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "commerce_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_checkoutId_fkey" FOREIGN KEY ("checkoutId") REFERENCES "commerce_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "commerce_sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "commerce_warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "commerce_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_allocations" ADD CONSTRAINT "commerce_allocations_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "commerce_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_allocations" ADD CONSTRAINT "commerce_allocations_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "commerce_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_events" ADD CONSTRAINT "commerce_order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_shipments" ADD CONSTRAINT "commerce_shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_cod_entries" ADD CONSTRAINT "commerce_cod_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_returns" ADD CONSTRAINT "commerce_returns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_return_items" ADD CONSTRAINT "commerce_return_items_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "commerce_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_return_items" ADD CONSTRAINT "commerce_return_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "commerce_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_coupon_uses" ADD CONSTRAINT "commerce_coupon_uses_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "commerce_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_supplier_products" ADD CONSTRAINT "commerce_supplier_products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "commerce_suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_supplier_products" ADD CONSTRAINT "commerce_supplier_products_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "commerce_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_purchase_orders" ADD CONSTRAINT "commerce_purchase_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "commerce_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_po_items" ADD CONSTRAINT "commerce_po_items_poId_fkey" FOREIGN KEY ("poId") REFERENCES "commerce_purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_po_items" ADD CONSTRAINT "commerce_po_items_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "commerce_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_supplier_payments" ADD CONSTRAINT "commerce_supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "commerce_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_supplier_payments" ADD CONSTRAINT "commerce_supplier_payments_poId_fkey" FOREIGN KEY ("poId") REFERENCES "commerce_purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Stock and money rules enforced by the database itself. (Flat comparisons only: BETWEEN does not
-- survive dump/restore byte-for-byte, which the recovery rehearsal checks.)
ALTER TABLE "commerce_batches" ADD CONSTRAINT "commerce_batches_stock_check" CHECK (
  "onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand" AND "quarantined" >= 0 AND "damaged" >= 0 AND "expired" >= 0 AND "unitCost" >= 0
);
ALTER TABLE "commerce_listings" ADD CONSTRAINT "commerce_listings_price_check" CHECK (
  "price" > 0 AND "price" <= "mrp" AND "maxPerOrder" >= 1
);
ALTER TABLE "commerce_listings" ADD CONSTRAINT "commerce_listings_promo_check" CHECK ("promoPrice" IS NULL OR "promoPrice" <= "price");
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_totals_check" CHECK (
  "subtotal" >= 0 AND "discountTotal" >= 0 AND "deliveryCharge" >= 0 AND "total" >= 0 AND "total" = "subtotal" - "discountTotal" + "deliveryCharge"
);
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_check" CHECK (
  "quantity" > 0 AND "unitPrice" > 0 AND "lineTotal" = "unitPrice" * "quantity" AND "costTotal" >= 0
);
ALTER TABLE "commerce_allocations" ADD CONSTRAINT "commerce_allocations_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "commerce_return_items" ADD CONSTRAINT "commerce_return_items_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "commerce_po_items" ADD CONSTRAINT "commerce_po_items_quantity_check" CHECK (
  "quantity" > 0 AND "accepted" >= 0 AND "rejected" >= 0 AND "accepted" <= "quantity"
);
ALTER TABLE "commerce_sellers" ADD CONSTRAINT "commerce_sellers_salon_check" CHECK (("type" = 'SALON') = ("salonId" IS NOT NULL));

-- The stock ledger, order history and cash ledger are append-only.
CREATE FUNCTION "commerce_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER "commerce_stock_movements_append_only" BEFORE UPDATE OR DELETE ON "commerce_stock_movements" FOR EACH ROW EXECUTE FUNCTION "commerce_append_only"();
CREATE TRIGGER "commerce_order_events_append_only" BEFORE UPDATE OR DELETE ON "commerce_order_events" FOR EACH ROW EXECUTE FUNCTION "commerce_append_only"();
CREATE TRIGGER "commerce_cod_entries_append_only" BEFORE UPDATE OR DELETE ON "commerce_cod_entries" FOR EACH ROW EXECUTE FUNCTION "commerce_append_only"();

-- FastQue is its own seller (not a salon). Business details are filled in under Settings.
INSERT INTO "commerce_sellers" ("id", "code", "type", "displayName", "updatedAt")
VALUES (gen_random_uuid(), 'FASTQUE', 'FASTQUE', 'FastQue', now());
