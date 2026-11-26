import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  DASHBOARD_PATHS,
  Role,
  bulkDeactivateSalonChairsApplySchema,
  bulkDeactivateSalonChairsPreviewSchema,
  createSalonChairSchema,
  createSalonServiceSchema,
  createSalonPhotoSchema,
  salonPhotoUploadMetaSchema,
  SALON_PHOTO_UPLOAD,
  createSalonStaffSchema,
  setOperatingHoursSchema,
  setSalonPaymentQrSchema,
  setSalonUpiSchema,
  setStaffWorkingHoursSchema,
  updateSalonChairSchema,
  updateSalonProfileSchema,
  updateSalonServiceSchema,
  updateSalonStaffSchema,
  updateSalonTypeSchema,
  updateSalonStatusSchema,
  updateSalonTimezoneSchema,
  serviceTaxonomyNodeInputSchema,
  submitSalonLocationProposalSchema,
  type AuthenticatedUser,
  type BulkDeactivateSalonChairsApplyInput,
  type BulkDeactivateSalonChairsPreviewInput,
  type CreateSalonChairInput,
  type CreateSalonServiceInput,
  type CreateSalonPhotoInput,
  type SalonPhotoUploadMetaInput,
  type CreateSalonStaffInput,
  type SetOperatingHoursInput,
  type SetSalonPaymentQrInput,
  type SetSalonUpiInput,
  type SetStaffWorkingHoursInput,
  type UpdateSalonChairInput,
  type UpdateSalonProfileInput,
  type UpdateSalonServiceInput,
  type UpdateSalonStaffInput,
  type UpdateSalonTypeInput,
  type UpdateSalonStatusInput,
  type UpdateSalonTimezoneInput,
  type SubmitSalonLocationProposalInput,
  type ServiceTaxonomyNodeInput,
} from '@barbercue/shared';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SalonServicesService } from './salon-services.service';
import { ServiceCatalogImportService } from './service-catalog-import.service';
import { SalonChairsService } from './salon-chairs.service';
import { SalonStaffService } from './salon-staff.service';
import { SalonActivationService } from './salon-activation.service';
import { SalonOperatingHoursService } from './salon-operating-hours.service';
import { SalonPhotosService } from './salon-photos.service';
import { StaffWorkingHoursService } from './staff-working-hours.service';
import { SalonTimezoneService } from './salon-timezone.service';
import { SalonPaymentQrService } from './salon-payment-qr.service';
import { SalonProfileService } from './salon-profile.service';
import { SalonLocationService } from './salon-location.service';

const SALON_SCOPE = `${DASHBOARD_PATHS.dashboard}/${DASHBOARD_PATHS.salons}/:salonId`;

/**
 * Salon owner setup (Phase 11): service catalog, chairs, barber roster, and shop activation.
 *
 * SALON_OWNER-only at the controller level — staff/barbers use the live-queue dashboard, they do
 * not configure the shop. That role check is only the outer gate: every service method also calls
 * SalonAccessService.assertOwnerAccess(userId, salonId), which is what actually prevents one owner
 * from managing another owner's salon. Both layers are required — the role alone says "an owner",
 * assertOwnerAccess says "an owner *of this salon*".
 *
 * PLATFORM_ADMIN is allowed through the controller-level role list for delegated support. Every
 * service method still performs its own explicit owner-or-admin salon authorization and records
 * the real admin actor for mutations; staff never receives this controller role.
 *
 * Routes live under the existing `dashboard/salons/:salonId/...` shape. Note DashboardQueueController
 * separately owns `dashboard/staff/:id/status` (clock in/out for an existing barber) — a different
 * path from this controller's `dashboard/salons/:salonId/staff/:staffId`, so the two never collide.
 */
@Controller()
@Roles(Role.SALON_OWNER, Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
export class SalonSetupController {
  constructor(
    private readonly services: SalonServicesService,
    private readonly catalogImports: ServiceCatalogImportService,
    private readonly chairs: SalonChairsService,
    private readonly staff: SalonStaffService,
    private readonly activation: SalonActivationService,
    private readonly operatingHours: SalonOperatingHoursService,
    private readonly photos: SalonPhotosService,
    private readonly staffWorkingHours: StaffWorkingHoursService,
    private readonly timezone: SalonTimezoneService,
    private readonly paymentQr: SalonPaymentQrService,
    private readonly profile: SalonProfileService,
    private readonly location: SalonLocationService,
  ) {}

  // ---------- Shop profile (Part 2, admin delegated shop management) ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.profile}`)
  getProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.profile.get(user.id, salonId);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.profile}`)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(updateSalonProfileSchema))
    body: UpdateSalonProfileInput,
  ) {
    return this.profile.update(user.id, salonId, body);
  }

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.location}`)
  getLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.location.get(user.id, salonId);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.location}`)
  proposeLocation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(submitSalonLocationProposalSchema))
    body: SubmitSalonLocationProposalInput,
  ) {
    return this.location.submit(user.id, salonId, body);
  }

  // ---------- Shop activation ----------

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.status}`)
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(updateSalonStatusSchema))
    body: UpdateSalonStatusInput,
  ) {
    return this.activation.updateStatus(user.id, salonId, body);
  }

  // ---------- Timezone ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.timezone}`)
  getTimezone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.timezone.getTimezone(user.id, salonId);
  }

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.photoReadiness}`)
  getPhotoReadiness(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.activation.getPhotoReadiness(user.id, salonId);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.timezone}`)
  updateTimezone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(updateSalonTimezoneSchema))
    body: UpdateSalonTimezoneInput,
  ) {
    return this.timezone.updateTimezone(user.id, salonId, body);
  }

  // ---------- Payment QR (FastQue Credits / Wallet V1) ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.paymentQr}`)
  getPaymentQr(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.paymentQr.get(user.id, salonId);
  }

  @Put(`${SALON_SCOPE}/${DASHBOARD_PATHS.paymentQr}`)
  setPaymentQr(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(setSalonPaymentQrSchema))
    body: SetSalonPaymentQrInput,
  ) {
    return this.paymentQr.setLink(user.id, salonId, body);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.paymentQr}`)
  setUpiRouting(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(setSalonUpiSchema)) body: SetSalonUpiInput,
  ) {
    return this.paymentQr.setUpi(user.id, salonId, body);
  }

  // Multipart sibling of the JSON route above — same shape as photos' upload/link pair.
  @Post(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.paymentQr}/${DASHBOARD_PATHS.photoUpload}`,
  )
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: SALON_PHOTO_UPLOAD.maxBytes, files: 1 },
    }),
  )
  uploadPaymentQr(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.paymentQr.setFromUpload(user.id, salonId, file);
  }

  @Delete(`${SALON_SCOPE}/${DASHBOARD_PATHS.paymentQr}`)
  @HttpCode(HttpStatus.NO_CONTENT)
  removePaymentQr(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.paymentQr.remove(user.id, salonId);
  }

  // ---------- Operating hours ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.operatingHours}`)
  listOperatingHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.operatingHours.list(user.id, salonId);
  }

  // PUT, not PATCH: the body is the complete week and replaces whatever is stored, so the verb
  // matches the semantics (idempotent whole-resource replacement).
  @Put(`${SALON_SCOPE}/${DASHBOARD_PATHS.operatingHours}`)
  setOperatingHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(setOperatingHoursSchema))
    body: SetOperatingHoursInput,
  ) {
    return this.operatingHours.set(user.id, salonId, body);
  }

  // ---------- Services ----------

  @Get(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.services}/${DASHBOARD_PATHS.salonType}`,
  )
  getSalonType(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.services.getSalonType(user.id, salonId);
  }

  @Patch(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.services}/${DASHBOARD_PATHS.salonType}`,
  )
  updateSalonType(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(updateSalonTypeSchema))
    body: UpdateSalonTypeInput,
  ) {
    return this.services.updateSalonType(user.id, salonId, body);
  }

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}`)
  listServices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.services.list(user.id, salonId);
  }

  // Canonical salon-owned category tree from the Issue #221 API contract.
  @Get(`${SALON_SCOPE}/service-categories`)
  listServiceCategories(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.services.listCategories(user.id, salonId);
  }

  @Post(`${SALON_SCOPE}/service-categories`)
  createServiceCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(serviceTaxonomyNodeInputSchema)) body: ServiceTaxonomyNodeInput,
  ) {
    return this.services.createCategory(user.id, salonId, body);
  }

  @Patch(`${SALON_SCOPE}/service-categories/:categoryId`)
  renameServiceCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('categoryId') categoryId: string,
    @Body(new ZodValidationPipe(serviceTaxonomyNodeInputSchema)) body: ServiceTaxonomyNodeInput,
  ) {
    return this.services.renameCategory(user.id, salonId, categoryId, body);
  }

  @Delete(`${SALON_SCOPE}/service-categories/:categoryId`)
  deleteServiceCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('categoryId') categoryId: string,
  ) {
    return this.services.deleteCategory(user.id, salonId, categoryId);
  }

  @Post(`${SALON_SCOPE}/service-categories/:categoryId/subcategories`)
  createServiceSubcategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('categoryId') categoryId: string,
    @Body(new ZodValidationPipe(serviceTaxonomyNodeInputSchema)) body: ServiceTaxonomyNodeInput,
  ) {
    return this.services.createSubcategory(user.id, salonId, categoryId, body);
  }

  @Patch(`${SALON_SCOPE}/service-categories/:categoryId/subcategories/:subcategoryId`)
  renameServiceSubcategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('categoryId') categoryId: string,
    @Param('subcategoryId') subcategoryId: string,
    @Body(new ZodValidationPipe(serviceTaxonomyNodeInputSchema)) body: ServiceTaxonomyNodeInput,
  ) {
    return this.services.renameSubcategory(user.id, salonId, categoryId, subcategoryId, body);
  }

  @Delete(`${SALON_SCOPE}/service-categories/:categoryId/subcategories/:subcategoryId`)
  deleteServiceSubcategory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('categoryId') categoryId: string,
    @Param('subcategoryId') subcategoryId: string,
  ) {
    return this.services.deleteSubcategory(user.id, salonId, categoryId, subcategoryId);
  }

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/import-capabilities`)
  catalogImportCapabilities(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.catalogImports.capabilities(user.id, salonId);
  }

  // Preview never writes services. PDF/image extraction requires a deliberate external-AI consent.
  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/import-preview`)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 6 * 1024 * 1024, files: 1 },
    }),
  )
  previewServiceCatalog(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('consent') consent?: string,
  ) {
    return this.catalogImports.preview(
      user.id,
      salonId,
      file,
      consent === 'true',
    );
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/import-reviewed`)
  saveReviewedCatalog(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body() body: unknown,
  ) {
    return this.catalogImports.saveReviewed(user.id, salonId, body);
  }

  // Explicit permanent removal; never reachable through the legacy soft-delete action.
  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/delete-all`)
  deleteAllServices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body() body: unknown,
  ) {
    return this.services.deleteAll(user.id, salonId, body);
  }

  // Placed above dynamic /:serviceId routes; never physically deletes referenced rows.
  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/remove-all`)
  removeAllServices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body() body: unknown,
  ) {
    return this.services.removeAll(user.id, salonId, body);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}`)
  createService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(createSalonServiceSchema))
    body: CreateSalonServiceInput,
  ) {
    return this.services.create(user.id, salonId, body);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.services}/:serviceId`)
  updateService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('serviceId') serviceId: string,
    @Body(new ZodValidationPipe(updateSalonServiceSchema))
    body: UpdateSalonServiceInput,
  ) {
    return this.services.update(user.id, salonId, serviceId, body);
  }

  // ---------- Photos ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.photos}`)
  listPhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.photos.list(user.id, salonId);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.photos}`)
  createPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(createSalonPhotoSchema))
    body: CreateSalonPhotoInput,
  ) {
    return this.photos.create(user.id, salonId, body);
  }

  // Multipart sibling of the JSON route above — the owner uploads from their device instead of
  // linking. Separate route rather than an overload of the same one: a multipart body and a JSON
  // body cannot share a validation pipe, and keeping them apart leaves the existing JSON contract
  // byte-for-byte unchanged for any client already using it.
  @Post(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.photos}/${DASHBOARD_PATHS.photoUpload}`,
  )
  @UseInterceptors(
    FileInterceptor('image', {
      // Memory, not disk: the buffer is sniffed and forwarded straight to object storage, so the
      // API server never writes an uploaded file to its own filesystem. Same shape as the Style
      // Advisor's upload interceptor.
      storage: memoryStorage(),
      limits: { fileSize: SALON_PHOTO_UPLOAD.maxBytes, files: 1 },
    }),
  )
  uploadPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    // Multipart text fields arrive as strings; the schema is what turns `type` into a real
    // PhotoType and rejects anything else, exactly as the JSON route's pipe does.
    @Body(new ZodValidationPipe(salonPhotoUploadMetaSchema))
    meta: SalonPhotoUploadMetaInput,
  ) {
    return this.photos.createFromUpload(user.id, salonId, file, meta);
  }

  @Delete(`${SALON_SCOPE}/${DASHBOARD_PATHS.photos}/:photoId`)
  @HttpCode(HttpStatus.NO_CONTENT)
  removePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photos.remove(user.id, salonId, photoId);
  }

  // ---------- Chairs ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.chairs}`)
  listChairs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.chairs.list(user.id, salonId);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.chairs}`)
  createChair(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(createSalonChairSchema))
    body: CreateSalonChairInput,
  ) {
    return this.chairs.create(user.id, salonId, body);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.chairs}/:chairId`)
  updateChair(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('chairId') chairId: string,
    @Body(new ZodValidationPipe(updateSalonChairSchema))
    body: UpdateSalonChairInput,
  ) {
    return this.chairs.update(user.id, salonId, chairId, body);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.chairs}/bulk-deactivate/preview`)
  @HttpCode(HttpStatus.OK)
  previewBulkDeactivateChairs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(bulkDeactivateSalonChairsPreviewSchema))
    body: BulkDeactivateSalonChairsPreviewInput,
  ) {
    return this.chairs.previewBulkDeactivate(user.id, salonId, body);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.chairs}/bulk-deactivate/apply`)
  @HttpCode(HttpStatus.OK)
  bulkDeactivateChairs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(bulkDeactivateSalonChairsApplySchema))
    body: BulkDeactivateSalonChairsApplyInput,
  ) {
    return this.chairs.bulkDeactivate(user.id, salonId, body);
  }

  // ---------- Staff / barbers ----------

  @Get(`${SALON_SCOPE}/${DASHBOARD_PATHS.staff}`)
  listStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
  ) {
    return this.staff.list(user.id, salonId);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.staff}`)
  createStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Body(new ZodValidationPipe(createSalonStaffSchema))
    body: CreateSalonStaffInput,
  ) {
    return this.staff.create(user.id, salonId, body);
  }

  @Post(`${SALON_SCOPE}/${DASHBOARD_PATHS.staff}/:staffId/photo/${DASHBOARD_PATHS.photoUpload}`)
  @UseInterceptors(FileInterceptor('image', {
    storage: memoryStorage(),
    limits: { fileSize: SALON_PHOTO_UPLOAD.maxBytes, files: 1 },
  }))
  uploadStaffPortrait(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('staffId') staffId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.photos.uploadStaffPortrait(user.id, salonId, staffId, file);
  }

  @Patch(`${SALON_SCOPE}/${DASHBOARD_PATHS.staff}/:staffId`)
  updateStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('staffId') staffId: string,
    @Body(new ZodValidationPipe(updateSalonStaffSchema))
    body: UpdateSalonStaffInput,
  ) {
    return this.staff.update(user.id, salonId, staffId, body);
  }

  @Post(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.staff}/:staffId/${DASHBOARD_PATHS.resendInvite}`,
  )
  resendInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('staffId') staffId: string,
  ) {
    return this.staff.resendInvite(user.id, salonId, staffId);
  }

  // ---------- Barber working hours (Phase 7) ----------

  @Get(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.staff}/:staffId/${DASHBOARD_PATHS.workingHours}`,
  )
  listStaffWorkingHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('staffId') staffId: string,
  ) {
    return this.staffWorkingHours.list(user.id, salonId, staffId);
  }

  @Put(
    `${SALON_SCOPE}/${DASHBOARD_PATHS.staff}/:staffId/${DASHBOARD_PATHS.workingHours}`,
  )
  setStaffWorkingHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('salonId') salonId: string,
    @Param('staffId') staffId: string,
    @Body(new ZodValidationPipe(setStaffWorkingHoursSchema))
    body: SetStaffWorkingHoursInput,
  ) {
    return this.staffWorkingHours.set(user.id, salonId, staffId, body);
  }
}
