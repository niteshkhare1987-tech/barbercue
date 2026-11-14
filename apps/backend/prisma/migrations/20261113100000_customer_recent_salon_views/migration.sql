-- Customer dashboard: private "Recently viewed salons" history. Additive only.
-- One row per (customer, salon); deleted with either side. The application caps rows per customer.

-- CreateTable
CREATE TABLE "customer_recent_salon_views" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "salonId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_recent_salon_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_recent_salon_views_userId_viewedAt_idx" ON "customer_recent_salon_views"("userId", "viewedAt");

-- CreateIndex
CREATE INDEX "customer_recent_salon_views_salonId_idx" ON "customer_recent_salon_views"("salonId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_recent_salon_views_userId_salonId_key" ON "customer_recent_salon_views"("userId", "salonId");

-- AddForeignKey
ALTER TABLE "customer_recent_salon_views" ADD CONSTRAINT "customer_recent_salon_views_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_recent_salon_views" ADD CONSTRAINT "customer_recent_salon_views_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
