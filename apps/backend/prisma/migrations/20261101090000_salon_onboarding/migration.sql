-- Employee-to-admin salon onboarding. Additive only: new enums, new tables, one new sequence.
-- No existing table, column, constraint or row is altered or removed.

-- Display reference "FQ-ONB-<year>-NNNNNN"; uniqueness comes from the database sequence, not app code.
CREATE SEQUENCE "salon_onboarding_reference_seq";

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'RESUBMITTED', 'REJECTED', 'APPROVED', 'OWNER_INVITED', 'AWAITING_OWNER_ACTIVATION', 'READY_TO_PUBLISH', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "OnboardingGender" AS ENUM ('MEN', 'WOMEN', 'UNISEX');

-- CreateEnum
CREATE TYPE "OnboardingSalonKind" AS ENUM ('BARBER_SHOP', 'BEAUTY_SALON', 'UNISEX_SALON', 'SPA', 'OTHER');

-- CreateEnum
CREATE TYPE "OnboardingMediaCategory" AS ENUM ('EXTERIOR', 'INTERIOR', 'STATIONS', 'RECEPTION', 'LOGO', 'MENU', 'OTHER');

-- CreateEnum
CREATE TYPE "OnboardingServiceSource" AS ENUM ('MANUAL', 'AI_EXTRACTED');

-- CreateEnum
CREATE TYPE "OnboardingPriceType" AS ENUM ('FIXED', 'STARTS_FROM');

-- CreateEnum
CREATE TYPE "OnboardingReviewDecision" AS ENUM ('START_REVIEW', 'NOTE', 'CORRECTION', 'REQUEST_CHANGES', 'REJECT', 'APPROVE');

-- CreateEnum
CREATE TYPE "OnboardingInvitationStatus" AS ENUM ('PENDING', 'SENT', 'CAPTURED_DEV', 'FAILED', 'DELIVERY_UNAVAILABLE', 'ACCEPTED', 'REVOKED');

-- CreateTable
CREATE TABLE "salon_onboarding_applications" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL DEFAULT (((('FQ-ONB-'::text || to_char(now(), 'YYYY'::text)) || '-'::text) || lpad((nextval('salon_onboarding_reference_seq'::regclass))::text, 6, '0'::text))),
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'DRAFT',
    "leadId" TEXT NOT NULL,
    "salonId" TEXT,
    "assignedEmployeeId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "territory" VARCHAR(120),
    "reviewerId" TEXT,
    "salonName" VARCHAR(160) NOT NULL,
    "genderCategory" "OnboardingGender",
    "salonKind" "OnboardingSalonKind",
    "description" VARCHAR(2000),
    "brandName" VARCHAR(160),
    "websiteUrl" VARCHAR(500),
    "instagramUrl" VARCHAR(500),
    "mapsUrl" VARCHAR(1000),
    "isFranchise" BOOLEAN,
    "branchCount" INTEGER,
    "ownerName" VARCHAR(160),
    "ownerPhone" VARCHAR(20),
    "ownerWhatsapp" VARCHAR(20),
    "ownerEmail" VARCHAR(254),
    "alternatePhone" VARCHAR(20),
    "managerName" VARCHAR(160),
    "managerPhone" VARCHAR(20),
    "preferredLanguage" VARCHAR(40),
    "shopNumber" VARCHAR(60),
    "buildingName" VARCHAR(160),
    "streetAddress" VARCHAR(300),
    "locality" VARCHAR(160),
    "city" VARCHAR(120),
    "district" VARCHAR(120),
    "state" VARCHAR(120),
    "postalCode" VARCHAR(12),
    "country" VARCHAR(80),
    "landmark" VARCHAR(200),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "coordinatesSource" VARCHAR(16),
    "employeeCount" INTEGER,
    "chairCount" INTEGER,
    "activeChairCount" INTEGER,
    "maleStaffCount" INTEGER,
    "femaleStaffCount" INTEGER,
    "walkInsAccepted" BOOLEAN,
    "bookingsAccepted" BOOLEAN,
    "liveQueueSupported" BOOLEAN,
    "appointmentIntervalMinutes" INTEGER,
    "averageServiceMinutes" INTEGER,
    "specialTimings" VARCHAR(1000),
    "consentContact" BOOLEAN NOT NULL DEFAULT false,
    "consentListing" BOOLEAN NOT NULL DEFAULT false,
    "consentAccuracy" BOOLEAN NOT NULL DEFAULT false,
    "consentAuthorization" BOOLEAN NOT NULL DEFAULT false,
    "consentCapturedAt" TIMESTAMP(3),
    "gstin" VARCHAR(15),
    "businessRegistration" VARCHAR(200),
    "employeeNotes" VARCHAR(2000),
    "openQuestions" VARCHAR(2000),
    "internalNotes" VARCHAR(4000),
    "photoExceptionReason" VARCHAR(500),
    "photoExceptionById" TEXT,
    "changeRequest" JSONB,
    "firstSubmittedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "reviewStartedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedVersion" INTEGER,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" VARCHAR(1000),
    "publishAuthorizedAt" TIMESTAMP(3),
    "publishAuthorizedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_onboarding_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_hours" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" TIME(0),
    "closesAt" TIME(0),
    "closesNextDay" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "salon_onboarding_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_services" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "serviceName" VARCHAR(120) NOT NULL,
    "normalizedKey" VARCHAR(160) NOT NULL,
    "category" VARCHAR(80),
    "applicableGender" "OnboardingGender",
    "basePrice" DECIMAL(10,2),
    "priceType" "OnboardingPriceType" NOT NULL DEFAULT 'FIXED',
    "discountedPrice" DECIMAL(10,2),
    "durationMinutes" INTEGER,
    "description" VARCHAR(500),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceType" "OnboardingServiceSource" NOT NULL DEFAULT 'MANUAL',
    "sourceMediaId" TEXT,
    "sourcePage" INTEGER,
    "extractionConfidence" DOUBLE PRECISION,
    "uncertainFields" TEXT[],
    "confirmedByEmployee" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_onboarding_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_media" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "storageKey" VARCHAR(300) NOT NULL,
    "category" "OnboardingMediaCategory" NOT NULL,
    "originalFilename" VARCHAR(200) NOT NULL,
    "mimeType" VARCHAR(40) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "salon_onboarding_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_extractions" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "serviceCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" VARCHAR(60),
    "result" JSONB,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_onboarding_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_reviews" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "OnboardingReviewDecision" NOT NULL,
    "comments" VARCHAR(4000),
    "details" JSONB,
    "applicationVersion" INTEGER NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_onboarding_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_status_history" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "previousStatus" "OnboardingStatus",
    "newStatus" "OnboardingStatus" NOT NULL,
    "actorId" TEXT,
    "reason" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salon_onboarding_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salon_onboarding_invitations" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "passwordResetTokenId" TEXT,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'EMAIL',
    "status" "OnboardingInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(300),
    "createdById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salon_onboarding_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_applications_reference_key" ON "salon_onboarding_applications"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_applications_leadId_key" ON "salon_onboarding_applications"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_applications_salonId_key" ON "salon_onboarding_applications"("salonId");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_status_submittedAt_idx" ON "salon_onboarding_applications"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_assignedEmployeeId_status_idx" ON "salon_onboarding_applications"("assignedEmployeeId", "status");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_territory_status_idx" ON "salon_onboarding_applications"("territory", "status");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_city_idx" ON "salon_onboarding_applications"("city");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_ownerPhone_idx" ON "salon_onboarding_applications"("ownerPhone");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_ownerEmail_idx" ON "salon_onboarding_applications"("ownerEmail");

-- CreateIndex
CREATE INDEX "salon_onboarding_applications_reviewerId_status_idx" ON "salon_onboarding_applications"("reviewerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_hours_applicationId_dayOfWeek_key" ON "salon_onboarding_hours"("applicationId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "salon_onboarding_services_applicationId_sortOrder_idx" ON "salon_onboarding_services"("applicationId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_media_storageKey_key" ON "salon_onboarding_media"("storageKey");

-- CreateIndex
CREATE INDEX "salon_onboarding_media_applicationId_category_idx" ON "salon_onboarding_media"("applicationId", "category");

-- CreateIndex
CREATE INDEX "salon_onboarding_media_applicationId_sha256_idx" ON "salon_onboarding_media"("applicationId", "sha256");

-- CreateIndex
CREATE INDEX "salon_onboarding_extractions_applicationId_createdAt_idx" ON "salon_onboarding_extractions"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "salon_onboarding_reviews_applicationId_reviewedAt_idx" ON "salon_onboarding_reviews"("applicationId", "reviewedAt");

-- CreateIndex
CREATE INDEX "salon_onboarding_status_history_applicationId_createdAt_idx" ON "salon_onboarding_status_history"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "salon_onboarding_status_history_newStatus_createdAt_idx" ON "salon_onboarding_status_history"("newStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "salon_onboarding_invitations_passwordResetTokenId_key" ON "salon_onboarding_invitations"("passwordResetTokenId");

-- CreateIndex
CREATE INDEX "salon_onboarding_invitations_applicationId_createdAt_idx" ON "salon_onboarding_invitations"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "salon_onboarding_invitations_ownerUserId_status_idx" ON "salon_onboarding_invitations"("ownerUserId", "status");

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "employee_crm_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_salonId_fkey" FOREIGN KEY ("salonId") REFERENCES "salons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_assignedEmployeeId_fkey" FOREIGN KEY ("assignedEmployeeId") REFERENCES "employee_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_hours" ADD CONSTRAINT "salon_onboarding_hours_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_services" ADD CONSTRAINT "salon_onboarding_services_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_services" ADD CONSTRAINT "salon_onboarding_services_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "salon_onboarding_media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_media" ADD CONSTRAINT "salon_onboarding_media_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_media" ADD CONSTRAINT "salon_onboarding_media_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_extractions" ADD CONSTRAINT "salon_onboarding_extractions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_extractions" ADD CONSTRAINT "salon_onboarding_extractions_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "salon_onboarding_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_reviews" ADD CONSTRAINT "salon_onboarding_reviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_reviews" ADD CONSTRAINT "salon_onboarding_reviews_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_status_history" ADD CONSTRAINT "salon_onboarding_status_history_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_status_history" ADD CONSTRAINT "salon_onboarding_status_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_invitations" ADD CONSTRAINT "salon_onboarding_invitations_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "salon_onboarding_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_invitations" ADD CONSTRAINT "salon_onboarding_invitations_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salon_onboarding_invitations" ADD CONSTRAINT "salon_onboarding_invitations_passwordResetTokenId_fkey" FOREIGN KEY ("passwordResetTokenId") REFERENCES "password_reset_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written integrity checks (Prisma's DSL has no CHECK support).
ALTER TABLE "salon_onboarding_hours" ADD CONSTRAINT "salon_onboarding_hours_day_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6);
ALTER TABLE "salon_onboarding_hours" ADD CONSTRAINT "salon_onboarding_hours_times_check" CHECK ("isClosed" OR ("opensAt" IS NOT NULL AND "closesAt" IS NOT NULL));
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_coords_check" CHECK (("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180 AND "coordinatesSource" IN ('GPS', 'MAP_PIN', 'MANUAL'))));
ALTER TABLE "salon_onboarding_applications" ADD CONSTRAINT "salon_onboarding_applications_counts_check" CHECK (COALESCE("employeeCount", 0) >= 0 AND COALESCE("chairCount", 0) >= 0 AND COALESCE("activeChairCount", 0) >= 0 AND COALESCE("maleStaffCount", 0) >= 0 AND COALESCE("femaleStaffCount", 0) >= 0 AND COALESCE("branchCount", 1) >= 1);
ALTER TABLE "salon_onboarding_services" ADD CONSTRAINT "salon_onboarding_services_values_check" CHECK (("basePrice" IS NULL OR "basePrice" >= 0) AND ("discountedPrice" IS NULL OR "discountedPrice" >= 0) AND ("durationMinutes" IS NULL OR "durationMinutes" BETWEEN 1 AND 600));
ALTER TABLE "salon_onboarding_media" ADD CONSTRAINT "salon_onboarding_media_size_check" CHECK ("fileSize" > 0);
