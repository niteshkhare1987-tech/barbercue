-- AlterTable
ALTER TABLE "commerce_orders" ADD COLUMN     "promotions" JSONB;

-- CreateTable
CREATE TABLE "commerce_reviews" (
    "id" UUID NOT NULL,
    "listingId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "customerUserId" TEXT,
    "displayName" VARCHAR(60) NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" VARCHAR(1500),
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "reply" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_tickets" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "orderId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "listingId" UUID,
    "shipmentId" UUID,
    "customerUserId" TEXT,
    "category" VARCHAR(20) NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "priority" VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
    "assignedToUserId" TEXT,
    "firstResponseAt" TIMESTAMPTZ(6),
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_ticket_messages" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorKind" VARCHAR(10) NOT NULL,
    "authorUserId" TEXT,
    "body" VARCHAR(3000) NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_promotions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" VARCHAR(15) NOT NULL,
    "listingIds" TEXT[],
    "buyQty" INTEGER NOT NULL DEFAULT 1,
    "getQty" INTEGER NOT NULL DEFAULT 0,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pinRules" TEXT[],
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_listing_details" (
    "listingId" UUID NOT NULL,
    "ingredients" VARCHAR(4000),
    "usage" VARCHAR(2000),
    "benefits" VARCHAR(2000),
    "warnings" VARCHAR(2000),
    "countryOfOrigin" VARCHAR(60),
    "manufacturer" VARCHAR(300),
    "shelfLifeMonths" INTEGER,
    "variantGroup" VARCHAR(60),
    "variantLabel" VARCHAR(60),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_listing_details_pkey" PRIMARY KEY ("listingId")
);

-- CreateTable
CREATE TABLE "commerce_banners" (
    "id" UUID NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "subtitle" VARCHAR(200),
    "imageUrl" VARCHAR(500),
    "linkPath" VARCHAR(200) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_banners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_saved_bags" (
    "userId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_saved_bags_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "commerce_daily_stats" (
    "day" DATE NOT NULL,
    "metric" VARCHAR(20) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "commerce_daily_stats_pkey" PRIMARY KEY ("day","metric")
);

-- CreateTable
CREATE TABLE "commerce_return_policies" (
    "category" VARCHAR(80) NOT NULL,
    "returnable" BOOLEAN NOT NULL DEFAULT true,
    "windowDays" INTEGER NOT NULL,
    "note" VARCHAR(300),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_return_policies_pkey" PRIMARY KEY ("category")
);

-- CreateTable
CREATE TABLE "commerce_files" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "orderId" UUID NOT NULL,
    "returnId" UUID,
    "storageKey" VARCHAR(300) NOT NULL,
    "mimeType" VARCHAR(60) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_settlement_imports" (
    "id" UUID NOT NULL,
    "courier" VARCHAR(80) NOT NULL,
    "fileName" VARCHAR(200) NOT NULL,
    "fileHash" VARCHAR(64) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_settlement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_settlement_lines" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "matchText" VARCHAR(80) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reference" VARCHAR(80),
    "orderId" UUID,
    "state" VARCHAR(10) NOT NULL,
    "message" VARCHAR(300),

    CONSTRAINT "commerce_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_warehouse_grants" (
    "userId" TEXT NOT NULL,
    "warehouseId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_warehouse_grants_pkey" PRIMARY KEY ("userId","warehouseId")
);

-- CreateTable
CREATE TABLE "commerce_stock_audits" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "createdByUserId" TEXT NOT NULL,
    "countedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),

    CONSTRAINT "commerce_stock_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_stock_audit_lines" (
    "id" UUID NOT NULL,
    "auditId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "systemQty" INTEGER,
    "counted" INTEGER,

    CONSTRAINT "commerce_stock_audit_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_purchase_requests" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "listingId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "createdByUserId" TEXT NOT NULL,
    "decidedByUserId" TEXT,
    "purchaseOrderId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_quotations" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "leadTimeDays" INTEGER,
    "validUntil" DATE,
    "note" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_supplier_returns" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "supplierId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "source" VARCHAR(12) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'SENT',
    "creditAmount" DECIMAL(12,2),
    "creditReference" VARCHAR(80),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_pickups" (
    "id" UUID NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "warehouseId" UUID NOT NULL,
    "courier" VARCHAR(80) NOT NULL,
    "pickupOn" DATE NOT NULL,
    "window" VARCHAR(40),
    "orderIds" TEXT[],
    "status" VARCHAR(10) NOT NULL DEFAULT 'SCHEDULED',
    "note" VARCHAR(300),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commerce_reviews_orderItemId_key" ON "commerce_reviews"("orderItemId");

-- CreateIndex
CREATE INDEX "commerce_reviews_listingId_status_idx" ON "commerce_reviews"("listingId", "status");

-- CreateIndex
CREATE INDEX "commerce_reviews_status_createdAt_idx" ON "commerce_reviews"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_tickets_number_key" ON "commerce_tickets"("number");

-- CreateIndex
CREATE INDEX "commerce_tickets_status_createdAt_idx" ON "commerce_tickets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_tickets_orderId_idx" ON "commerce_tickets"("orderId");

-- CreateIndex
CREATE INDEX "commerce_ticket_messages_ticketId_createdAt_idx" ON "commerce_ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_listing_details_variantGroup_idx" ON "commerce_listing_details"("variantGroup");

-- CreateIndex
CREATE INDEX "commerce_saved_bags_updatedAt_idx" ON "commerce_saved_bags"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_files_storageKey_key" ON "commerce_files"("storageKey");

-- CreateIndex
CREATE INDEX "commerce_files_orderId_idx" ON "commerce_files"("orderId");

-- CreateIndex
CREATE INDEX "commerce_files_returnId_idx" ON "commerce_files"("returnId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_settlement_imports_fileHash_key" ON "commerce_settlement_imports"("fileHash");

-- CreateIndex
CREATE INDEX "commerce_settlement_lines_orderId_idx" ON "commerce_settlement_lines"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_settlement_lines_importId_rowNumber_key" ON "commerce_settlement_lines"("importId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_stock_audits_number_key" ON "commerce_stock_audits"("number");

-- CreateIndex
CREATE INDEX "commerce_stock_audits_warehouseId_status_idx" ON "commerce_stock_audits"("warehouseId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_stock_audit_lines_auditId_batchId_key" ON "commerce_stock_audit_lines"("auditId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_purchase_requests_number_key" ON "commerce_purchase_requests"("number");

-- CreateIndex
CREATE INDEX "commerce_purchase_requests_status_createdAt_idx" ON "commerce_purchase_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "commerce_quotations_requestId_idx" ON "commerce_quotations"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_supplier_returns_number_key" ON "commerce_supplier_returns"("number");

-- CreateIndex
CREATE INDEX "commerce_supplier_returns_supplierId_idx" ON "commerce_supplier_returns"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_pickups_number_key" ON "commerce_pickups"("number");

-- CreateIndex
CREATE INDEX "commerce_pickups_status_pickupOn_idx" ON "commerce_pickups"("status", "pickupOn");

-- AddForeignKey
ALTER TABLE "commerce_ticket_messages" ADD CONSTRAINT "commerce_ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "commerce_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_settlement_lines" ADD CONSTRAINT "commerce_settlement_lines_importId_fkey" FOREIGN KEY ("importId") REFERENCES "commerce_settlement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_stock_audit_lines" ADD CONSTRAINT "commerce_stock_audit_lines_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "commerce_stock_audits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_quotations" ADD CONSTRAINT "commerce_quotations_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "commerce_purchase_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Rules enforced by the database (flat comparisons only).
ALTER TABLE "commerce_reviews" ADD CONSTRAINT "commerce_reviews_rating_check" CHECK ("rating" >= 1 AND "rating" <= 5);
ALTER TABLE "commerce_promotions" ADD CONSTRAINT "commerce_promotions_check" CHECK ("buyQty" >= 1 AND "getQty" >= 0 AND "value" >= 0);
ALTER TABLE "commerce_settlement_lines" ADD CONSTRAINT "commerce_settlement_lines_check" CHECK ("amount" >= 0 AND "deductions" >= 0);
ALTER TABLE "commerce_purchase_requests" ADD CONSTRAINT "commerce_purchase_requests_check" CHECK ("quantity" > 0);
ALTER TABLE "commerce_quotations" ADD CONSTRAINT "commerce_quotations_check" CHECK ("unitCost" > 0);
ALTER TABLE "commerce_supplier_returns" ADD CONSTRAINT "commerce_supplier_returns_check" CHECK ("quantity" > 0);
ALTER TABLE "commerce_return_policies" ADD CONSTRAINT "commerce_return_policies_check" CHECK ("windowDays" >= 0);
CREATE TRIGGER "commerce_ticket_messages_append_only" BEFORE UPDATE OR DELETE ON "commerce_ticket_messages" FOR EACH ROW EXECUTE FUNCTION "commerce_append_only"();
