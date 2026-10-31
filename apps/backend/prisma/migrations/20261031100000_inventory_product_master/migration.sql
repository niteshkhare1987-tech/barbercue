-- CreateEnum
CREATE TYPE "StockUsage" AS ENUM ('PROFESSIONAL', 'RETAIL');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PROFESSIONAL', 'RETAIL', 'BOTH');

-- CreateEnum
CREATE TYPE "ProductDataSource" AS ENUM ('ADMIN', 'CSV_IMPORT', 'OPEN_BEAUTY_FACTS', 'SALON_SUBMITTED');

-- CreateEnum
CREATE TYPE "ProductVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BarcodeFormat" AS ENUM ('GTIN', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryMovementKind" ADD VALUE 'RETURN';
ALTER TYPE "InventoryMovementKind" ADD VALUE 'DAMAGE';
ALTER TYPE "InventoryMovementKind" ADD VALUE 'EXPIRY';
ALTER TYPE "InventoryMovementKind" ADD VALUE 'WASTAGE';
ALTER TYPE "InventoryMovementKind" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "InventoryMovementKind" ADD VALUE 'TRANSFER_IN';

-- AlterTable
ALTER TABLE "inventory_products" ADD COLUMN     "globalProductId" TEXT,
ADD COLUMN     "minimumOrderQuantity" DECIMAL(12,3),
ADD COLUMN     "sellingPrice" DECIMAL(12,2),
ADD COLUMN     "storageLocation" VARCHAR(80),
ADD COLUMN     "usage" "StockUsage" NOT NULL DEFAULT 'PROFESSIONAL';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "batchNumber" VARCHAR(60),
ADD COLUMN     "expiryDate" DATE,
ADD COLUMN     "transferGroupId" UUID;

-- CreateTable
CREATE TABLE "global_products" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "normalizedName" VARCHAR(160) NOT NULL,
    "brand" VARCHAR(120),
    "manufacturer" VARCHAR(160),
    "category" VARCHAR(80),
    "subcategory" VARCHAR(80),
    "description" VARCHAR(1000),
    "packSize" DECIMAL(12,3),
    "packUnit" "InventoryUnit",
    "mrp" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "hsnCode" VARCHAR(8),
    "gstRatePercent" DECIMAL(5,2),
    "productType" "ProductType" NOT NULL DEFAULT 'BOTH',
    "dataSource" "ProductDataSource" NOT NULL,
    "sourceReference" VARCHAR(300),
    "sourceLicense" VARCHAR(80),
    "verificationStatus" "ProductVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "submittedBySalonId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewNote" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "global_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_product_barcodes" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "display" VARCHAR(64) NOT NULL,
    "format" "BarcodeFormat" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_product_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_product_images" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "global_product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "global_products_verificationStatus_createdAt_idx" ON "global_products"("verificationStatus", "createdAt");

-- CreateIndex
CREATE INDEX "global_products_normalizedName_idx" ON "global_products"("normalizedName");

-- CreateIndex
CREATE INDEX "global_products_submittedBySalonId_idx" ON "global_products"("submittedBySalonId");

-- CreateIndex
CREATE UNIQUE INDEX "global_product_barcodes_code_key" ON "global_product_barcodes"("code");

-- CreateIndex
CREATE INDEX "global_product_barcodes_productId_idx" ON "global_product_barcodes"("productId");

-- CreateIndex
CREATE INDEX "global_product_images_productId_sortOrder_idx" ON "global_product_images"("productId", "sortOrder");

-- CreateIndex
CREATE INDEX "inventory_products_globalProductId_idx" ON "inventory_products"("globalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_products_salonId_globalProductId_usage_key" ON "inventory_products"("salonId", "globalProductId", "usage");

-- AddForeignKey
ALTER TABLE "inventory_products" ADD CONSTRAINT "inventory_products_globalProductId_fkey" FOREIGN KEY ("globalProductId") REFERENCES "global_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_products" ADD CONSTRAINT "global_products_submittedBySalonId_fkey" FOREIGN KEY ("submittedBySalonId") REFERENCES "salons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_products" ADD CONSTRAINT "global_products_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_products" ADD CONSTRAINT "global_products_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_product_barcodes" ADD CONSTRAINT "global_product_barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "global_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "global_product_images" ADD CONSTRAINT "global_product_images_productId_fkey" FOREIGN KEY ("productId") REFERENCES "global_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

