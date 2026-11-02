import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SalonSetupModule } from '../salon-setup/salon-setup.module';
import { EmployeeOnboardingController } from './employee-onboarding.controller';
import { AdminOnboardingController } from './admin-onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingMediaService } from './onboarding-media.service';
import { AdminOnboardingService } from './admin-onboarding.service';
import { OnboardingApprovalService } from './onboarding-approval.service';
import { OnboardingPublishService } from './onboarding-publish.service';
import { OnboardingAnalyticsService } from './onboarding-analytics.service';
import { OnboardingNotifierService } from './onboarding-notifier.service';
import { OnboardingDuplicatesService } from './onboarding-duplicates.service';
import {
  MENU_EXTRACTOR,
  menuExtractorFromEnv,
} from './menu-extraction/menu-extractor';

/** Employee-to-admin salon onboarding (see packages/shared/src/onboarding.ts for the route map). */
@Module({
  imports: [AuthModule, StorageModule, NotificationsModule, SalonSetupModule],
  controllers: [EmployeeOnboardingController, AdminOnboardingController],
  providers: [
    OnboardingService,
    OnboardingMediaService,
    AdminOnboardingService,
    OnboardingApprovalService,
    OnboardingPublishService,
    OnboardingAnalyticsService,
    OnboardingNotifierService,
    OnboardingDuplicatesService,
    { provide: MENU_EXTRACTOR, useFactory: menuExtractorFromEnv },
  ],
  exports: [OnboardingAnalyticsService],
})
export class OnboardingModule {}
