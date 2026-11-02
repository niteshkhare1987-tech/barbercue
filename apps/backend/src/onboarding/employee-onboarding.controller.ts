import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import {
  EMPLOYEE_PATHS,
  ONBOARDING_MEDIA_LIMITS,
  Role,
  createOnboardingSchema,
  onboardingDraftSchema,
  onboardingListQuerySchema,
  onboardingMediaUploadMetaSchema,
  replaceOnboardingServicesSchema,
  type AuthenticatedUser,
  type CreateOnboardingInput,
  type OnboardingDraftInput,
  type ReplaceOnboardingServicesInput,
} from '@barbercue/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OnboardingService } from './onboarding.service';
import { OnboardingMediaService } from './onboarding-media.service';
import { OnboardingAnalyticsService } from './onboarding-analytics.service';

const ONBOARDING = EMPLOYEE_PATHS.onboarding;
const UPLOAD_THROTTLE = { default: { limit: 20, ttl: 60_000 } };
const EXTRACT_THROTTLE = { default: { limit: 6, ttl: 60_000 } };
const submitSchema = z
  .object({ expectedVersion: z.number().int().min(1).optional() })
  .strict();
const fromLeadSchema = createOnboardingSchema.partial();

/** Field employees only. Every query is scoped to the caller's own (or territory-shared,
 * read-only) applications inside the services; hidden buttons are not the security boundary. */
@Controller(EMPLOYEE_PATHS.employee)
@Roles(Role.FIELD_EXECUTIVE)
export class EmployeeOnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly media: OnboardingMediaService,
    private readonly analytics: OnboardingAnalyticsService,
  ) {}

  @Post(ONBOARDING)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createOnboardingSchema))
    body: CreateOnboardingInput,
  ) {
    return this.onboarding.create(user.id, body);
  }

  @Post(`${EMPLOYEE_PATHS.leads}/:leadId/${ONBOARDING}`)
  createFromLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body(new ZodValidationPipe(fromLeadSchema))
    body: Partial<CreateOnboardingInput>,
  ) {
    return this.onboarding.createFromLead(user.id, leadId, body ?? {});
  }

  @Get(ONBOARDING)
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(onboardingListQuerySchema))
    query: z.infer<typeof onboardingListQuerySchema>,
  ) {
    return this.onboarding.list(user.id, query.bucket);
  }

  @Get(`${ONBOARDING}/${EMPLOYEE_PATHS.counts}`)
  counts(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.counts(user.id);
  }

  @Get(`${ONBOARDING}/${EMPLOYEE_PATHS.analytics}`)
  async myAnalytics(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.onboarding.requireProfile(user.id);
    return this.analytics.forEmployee(profile.id);
  }

  @Get(`${ONBOARDING}/:id`)
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.onboarding.get(user.id, id);
  }

  @Get(`${ONBOARDING}/:id/duplicates`)
  duplicates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.onboarding.duplicatesFor(user.id, id);
  }

  @Patch(`${ONBOARDING}/:id`)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(onboardingDraftSchema))
    body: OnboardingDraftInput,
  ) {
    return this.onboarding.update(user.id, id, body);
  }

  @Put(`${ONBOARDING}/:id/${EMPLOYEE_PATHS.services}`)
  replaceServices(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(replaceOnboardingServicesSchema))
    body: ReplaceOnboardingServicesInput,
  ) {
    return this.onboarding.replaceServices(user.id, id, body);
  }

  @Post(`${ONBOARDING}/:id/${EMPLOYEE_PATHS.media}`)
  @Throttle(UPLOAD_THROTTLE)
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: {
        fileSize: ONBOARDING_MEDIA_LIMITS.maxBytes,
        files: 1,
        fields: 4,
      },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodValidationPipe(onboardingMediaUploadMetaSchema))
    meta: z.infer<typeof onboardingMediaUploadMetaSchema>,
  ) {
    return this.media.upload(user.id, id, file, meta.category);
  }

  @Delete(`${ONBOARDING}/:id/${EMPLOYEE_PATHS.media}/:mediaId`)
  removeMedia(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ) {
    return this.media.remove(user.id, id, mediaId);
  }

  @Get(
    `${ONBOARDING}/:id/${EMPLOYEE_PATHS.media}/:mediaId/${EMPLOYEE_PATHS.file}`,
  )
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async file(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ) {
    const file = await this.media.readForEmployee(user.id, id, mediaId);
    return new StreamableFile(file.body, {
      type: file.mimeType,
      disposition: 'inline',
    });
  }

  @Post(
    `${ONBOARDING}/:id/${EMPLOYEE_PATHS.media}/:mediaId/${EMPLOYEE_PATHS.extract}`,
  )
  @Throttle(EXTRACT_THROTTLE)
  extract(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
  ) {
    return this.media.extract(user.id, id, mediaId);
  }

  @Post(`${ONBOARDING}/:id/${EMPLOYEE_PATHS.submit}`)
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(submitSchema))
    body: z.infer<typeof submitSchema>,
  ) {
    return this.onboarding.submit(user.id, id, body?.expectedVersion);
  }
}
