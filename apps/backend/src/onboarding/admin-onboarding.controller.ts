import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ADMIN_PATHS,
  EMPLOYEE_PATHS,
  Role,
  adminOnboardingListQuerySchema,
  onboardingApproveSchema,
  onboardingAssignReviewerSchema,
  onboardingCorrectionSchema,
  onboardingNotesSchema,
  onboardingPhotoExceptionSchema,
  onboardingRejectSchema,
  onboardingRequestChangesSchema,
  onboardingSuspendSchema,
  type AdminOnboardingListQuery,
  type AuthenticatedUser,
  type OnboardingApproveInput,
  type OnboardingCorrectionInput,
  type OnboardingRejectInput,
  type OnboardingRequestChangesInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AdminOnboardingService } from './admin-onboarding.service';
import { OnboardingApprovalService } from './onboarding-approval.service';
import { OnboardingPublishService } from './onboarding-publish.service';
import { OnboardingAnalyticsService } from './onboarding-analytics.service';
import { OnboardingMediaService } from './onboarding-media.service';

const BASE = `${ADMIN_PATHS.admin}/${ADMIN_PATHS.onboarding}`;
const promoteSchema = z
  .object({ mediaIds: z.array(z.string().uuid()).min(1).max(10) })
  .strict();

/**
 * Read routes: PLATFORM_ADMIN, CO_FOUNDER, SALES_ADMIN, PLATFORM_VIEWER (viewers get masked owner
 * contacts). Decisions: PLATFORM_ADMIN and CO_FOUNDER only, re-checked in the services together
 * with "never your own application". Publishing and suspending open/close a live salon through
 * SalonActivationService, which is PLATFORM_ADMIN-only.
 */
@Controller(BASE)
@Roles(
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.SALES_ADMIN,
  Role.PLATFORM_VIEWER,
)
export class AdminOnboardingController {
  constructor(
    private readonly admin: AdminOnboardingService,
    private readonly approval: OnboardingApprovalService,
    private readonly publishing: OnboardingPublishService,
    private readonly analytics: OnboardingAnalyticsService,
    private readonly media: OnboardingMediaService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(adminOnboardingListQuerySchema))
    query: AdminOnboardingListQuery,
  ) {
    return this.admin.list(user, query);
  }

  @Get(ADMIN_PATHS.kpis)
  kpis() {
    return this.admin.kpis();
  }

  @Get(ADMIN_PATHS.analytics)
  @Roles(
    Role.PLATFORM_ADMIN,
    Role.CO_FOUNDER,
    Role.SALES_ADMIN,
    Role.HR_ADMIN,
    Role.PLATFORM_VIEWER,
  )
  teamAnalytics() {
    return this.analytics.forTeam();
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.admin.get(user, id);
  }

  @Get(':id/duplicates')
  duplicates(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.duplicatesFor(id);
  }

  @Get(`:id/${EMPLOYEE_PATHS.media}/:mediaId/${EMPLOYEE_PATHS.file}`)
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ) {
    const file = await this.media.read(id, mediaId);
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: 'inline',
    });
  }

  @Get(':id/publish-readiness')
  readiness(@Param('id', ParseUUIDPipe) id: string) {
    return this.publishing.readiness(id);
  }

  @Post(`:id/${ADMIN_PATHS.startReview}`)
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  startReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.admin.startReview(user, id);
  }

  @Post(':id/assign-reviewer')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  assignReviewer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingAssignReviewerSchema))
    body: { reviewerId: string | null },
  ) {
    return this.admin.assignReviewer(user, id, body.reviewerId);
  }

  @Post(':id/notes')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  notes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingNotesSchema))
    body: { internalNotes: string },
  ) {
    return this.admin.saveNotes(user, id, body.internalNotes);
  }

  @Patch(':id/corrections')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  correct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingCorrectionSchema))
    body: OnboardingCorrectionInput,
  ) {
    return this.admin.correct(user, id, body);
  }

  @Post(':id/photo-exception')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  photoException(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingPhotoExceptionSchema))
    body: { reason: string | null },
  ) {
    return this.admin.setPhotoException(user, id, body.reason);
  }

  @Post(':id/request-changes')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  requestChanges(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingRequestChangesSchema))
    body: OnboardingRequestChangesInput,
  ) {
    return this.admin.requestChanges(user, id, body);
  }

  @Post(':id/reject')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingRejectSchema))
    body: OnboardingRejectInput,
  ) {
    return this.admin.reject(user, id, body);
  }

  @Post(':id/approve')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingApproveSchema))
    body: OnboardingApproveInput,
  ) {
    return this.approval.approve(user, id, body);
  }

  @Post(':id/invitation/resend')
  @Roles(Role.PLATFORM_ADMIN, Role.CO_FOUNDER)
  resendInvitation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.approval.resendInvitation(user, id);
  }

  @Post(':id/photos/publish')
  @Roles(Role.PLATFORM_ADMIN)
  promotePhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(promoteSchema))
    body: z.infer<typeof promoteSchema>,
  ) {
    return this.publishing.promotePhotos(user, id, body.mediaIds);
  }

  @Post(':id/publish')
  @Roles(Role.PLATFORM_ADMIN)
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.publishing.publish(user, id);
  }

  @Post(':id/suspend')
  @Roles(Role.PLATFORM_ADMIN)
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingSuspendSchema))
    body: { reason: string },
  ) {
    return this.publishing.suspend(user, id, body.reason);
  }
}
