-- CreateEnum
CREATE TYPE "ServiceUsageStatus" AS ENUM ('RECORDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ServiceUsageSource" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "inventory_products" ADD COLUMN     "contentSize" DECIMAL(12,3),
ADD COLUMN     "contentUnit" "InventoryUnit";

-- CreateTable
CREATE TABLE "service_product_rules" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "inventoryCategoryId" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" "InventoryUnit" NOT NULL,
    "defaultProductId" TEXT,
    "autoDeduct" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_product_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_usages" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "queueEntryId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT,
    "status" "ServiceUsageStatus" NOT NULL DEFAULT 'RECORDED',
    "source" "ServiceUsageSource" NOT NULL DEFAULT 'MANUAL',
    "recordedByUserId" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMPTZ(6),
    "reversedByUserId" TEXT,
    "reversalReason" VARCHAR(300),

    CONSTRAINT "service_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_usage_items" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ruleId" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "enteredQuantity" DECIMAL(12,3) NOT NULL,
    "enteredUnit" "InventoryUnit" NOT NULL,
    "movementId" TEXT NOT NULL,
    "reversalMovementId" TEXT,

    CONSTRAINT "service_usage_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_product_rules_salonId_serviceId_idx" ON "service_product_rules"("salonId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "service_product_rules_serviceId_inventoryCategoryId_key" ON "service_product_rules"("serviceId", "inventoryCategoryId");

-- CreateIndex
CREATE INDEX "service_usages_salonId_recordedAt_idx" ON "service_usages"("salonId", "recordedAt");

-- CreateIndex
CREATE INDEX "service_usages_queueEntryId_idx" ON "service_usages"("queueEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "service_usage_items_movementId_key" ON "service_usage_items"("movementId");

-- CreateIndex
CREATE UNIQUE INDEX "service_usage_items_reversalMovementId_key" ON "service_usage_items"("reversalMovementId");

-- CreateIndex
CREATE INDEX "service_usage_items_productId_idx" ON "service_usage_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "service_usage_items_usageId_productId_key" ON "service_usage_items"("usageId", "productId");

-- AddForeignKey
ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_salonId_serviceId_fkey" FOREIGN KEY ("salonId", "serviceId") REFERENCES "services"("salonId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_inventoryCategoryId_salonId_fkey" FOREIGN KEY ("inventoryCategoryId", "salonId") REFERENCES "inventory_categories"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_defaultProductId_salonId_fkey" FOREIGN KEY ("defaultProductId", "salonId") REFERENCES "inventory_products"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_queueEntryId_fkey" FOREIGN KEY ("queueEntryId") REFERENCES "queue_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_salonId_serviceId_fkey" FOREIGN KEY ("salonId", "serviceId") REFERENCES "services"("salonId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "salon_staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "service_usages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_productId_salonId_fkey" FOREIGN KEY ("productId", "salonId") REFERENCES "inventory_products"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "service_product_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_reversalMovementId_fkey" FOREIGN KEY ("reversalMovementId") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Inventory Phase 2 rules Prisma cannot express.

-- One RECORDED usage per service per visit: a repeated completion event or double tap can never
-- deduct twice. A correction marks the old row REVERSED (with reversal entries) before re-recording.
CREATE UNIQUE INDEX "service_usages_one_recorded_per_visit_service"
  ON "service_usages" ("queueEntryId", "serviceId") WHERE "status" = 'RECORDED';

ALTER TABLE "service_usages" ADD CONSTRAINT "service_usages_reversal_shape_check" CHECK (
  ("status" = 'RECORDED' AND "reversedAt" IS NULL AND "reversedByUserId" IS NULL AND "reversalReason" IS NULL)
  OR ("status" = 'REVERSED' AND "reversedAt" IS NOT NULL AND "reversedByUserId" IS NOT NULL AND "reversalReason" IS NOT NULL)
);

ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "service_product_rules" ADD CONSTRAINT "service_product_rules_auto_deduct_check"
  CHECK (NOT "autoDeduct" OR "defaultProductId" IS NOT NULL);

ALTER TABLE "service_usage_items" ADD CONSTRAINT "service_usage_items_quantity_check"
  CHECK ("quantity" > 0 AND "enteredQuantity" > 0);

ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_content_check" CHECK (
  ("contentSize" IS NULL AND "contentUnit" IS NULL) OR ("contentSize" > 0 AND "contentUnit" IS NOT NULL)
);

-- Products already linked to the catalog and counted in pieces/packs/boxes: one counted unit holds
-- the catalog pack size (e.g. a 195 ml bottle), so recipes in ml/g work from day one.
UPDATE "inventory_products" p
SET "contentSize" = g."packSize", "contentUnit" = g."packUnit"
FROM "global_products" g
WHERE p."globalProductId" = g."id"
  AND p."unit" IN ('EACH', 'PACK', 'BOX')
  AND p."contentSize" IS NULL
  AND g."packSize" > 0
  AND g."packUnit" IN ('GRAM', 'KILOGRAM', 'MILLILITER', 'LITER', 'EACH');
