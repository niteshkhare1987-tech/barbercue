-- CreateEnum
CREATE TYPE "InventoryAlertKind" AS ENUM ('REORDER', 'STOCK_OUT', 'EXPIRING', 'EXPIRED');

-- AlterTable
ALTER TABLE "inventory_suppliers" ADD COLUMN     "leadTimeDays" INTEGER;

-- CreateTable
CREATE TABLE "inventory_settings" (
    "salonId" TEXT NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 5,
    "safetyDays" INTEGER NOT NULL DEFAULT 3,
    "coverDays" INTEGER NOT NULL DEFAULT 14,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastAlertRunAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("salonId")
);

-- CreateTable
CREATE TABLE "inventory_alerts" (
    "id" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "productId" TEXT,
    "kind" "InventoryAlertKind" NOT NULL,
    "dedupeKey" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "detail" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "dismissedAt" TIMESTAMPTZ(6),
    "dismissedByUserId" TEXT,

    CONSTRAINT "inventory_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_alerts_salonId_resolvedAt_createdAt_idx" ON "inventory_alerts"("salonId", "resolvedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_alerts" ADD CONSTRAINT "inventory_alerts_productId_salonId_fkey" FOREIGN KEY ("productId", "salonId") REFERENCES "inventory_products"("id", "salonId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Inventory Phase 3 rules Prisma cannot express.

-- One open alert per problem: the owner is told once, not every day.
CREATE UNIQUE INDEX "inventory_alerts_one_open_per_problem"
  ON "inventory_alerts" ("salonId", "dedupeKey") WHERE "resolvedAt" IS NULL;

ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_ranges_check" CHECK (
  "leadTimeDays" BETWEEN 0 AND 90 AND "safetyDays" BETWEEN 0 AND 60 AND "coverDays" BETWEEN 1 AND 120
);
ALTER TABLE "inventory_suppliers" ADD CONSTRAINT "inventory_suppliers_lead_time_check"
  CHECK ("leadTimeDays" IS NULL OR "leadTimeDays" BETWEEN 0 AND 90);
