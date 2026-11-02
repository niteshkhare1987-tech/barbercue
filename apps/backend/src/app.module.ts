import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { SalonsModule } from './salons/salons.module';
import { BookingsModule } from './bookings/bookings.module';
import { SalonAccessModule } from './common/salon-access/salon-access.module';
import { RealtimeModule } from './realtime/realtime.module';
import { QueueModule } from './queue/queue.module';
import { StyleAdvisorModule } from './style-advisor/style-advisor.module';
import { PremiumModule } from './premium/premium.module';
import { PublicQueueModule } from './public-queue/public-queue.module';
import { SalonSetupModule } from './salon-setup/salon-setup.module';
import { AdminModule } from './admin/admin.module';
import { DashboardBookingsModule } from './dashboard-bookings/dashboard-bookings.module';
import { DashboardCustomersModule } from './dashboard-customers/dashboard-customers.module';
import { DashboardAnalyticsModule } from './dashboard-analytics/dashboard-analytics.module';
import { DashboardOverviewModule } from './dashboard-overview/dashboard-overview.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PushNotificationsModule } from './push-notifications/push-notifications.module';
import { RemindersModule } from './reminders/reminders.module';
import { ReviewsModule } from './reviews/reviews.module';
import { DashboardReviewsModule } from './dashboard-reviews/dashboard-reviews.module';
import { VerificationModule } from './verification/verification.module';
import { CustomerCreditsModule } from './credits/customer-credits.module';
import { EmployeeModule } from './employee/employee.module';
import { DbDeadlineSchedulerModule } from './common/db-deadline-scheduler/db-deadline-scheduler.module';
import { SiteMetricsModule } from './site-metrics/site-metrics.module';
import { OwnerOpsModule } from './owner-ops/owner-ops.module';
import { SalonDescriptionModule } from './salon-description/salon-description.module';
import { InventoryModule } from './inventory/inventory.module';
import { OnboardingModule } from './onboarding/onboarding.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbDeadlineSchedulerModule,
    SiteMetricsModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    PrismaModule,
    SalonAccessModule,
    HealthModule,
    AuthModule,
    EmployeeModule,
    // BookingsModule and QueueModule are registered before SalonsModule so their
    // `salons/:salonId/...` sub-routes (BookingInfoController's `booking/{staff,availability,
    // cancellation-policy}`, SalonQueueController's `queue/{status,join}`) are matched by
    // Nest/Express before SalonsController's `salons/:countryCode/:citySlug/:salonSlug` route —
    // all of these are exactly 3 path-segments after `salons/`, and Express's router matches by
    // registration order, not specificity, so the fully-wildcard discovery route previously
    // intercepted every request shaped like one of these sub-routes (see BookingInfoController's
    // own doc comment, whose old "structurally non-overlapping" claim assumed order-independent
    // matching, which Express does not do). Any future `salons/:salonId/<literal>/...` controller
    // needs to be registered here too, before SalonsModule, or it will hit the same bug.
    CustomerCreditsModule,
    BookingsModule,
    QueueModule,
    // Owner-operations routes (dashboard/..., invoices/mine) — registered before SalonsModule like
    // the other salon-scoped controllers above.
    OwnerOpsModule,
    SalonDescriptionModule,
    InventoryModule,
    SalonsModule,
    RealtimeModule,
    PremiumModule,
    StyleAdvisorModule,
    PublicQueueModule,
    SalonSetupModule,
    // Before AdminModule so admin/onboarding/* never meets a broader admin route first.
    OnboardingModule,
    AdminModule,
    DashboardBookingsModule,
    DashboardCustomersModule,
    DashboardAnalyticsModule,
    DashboardOverviewModule,
    NotificationsModule,
    PushNotificationsModule,
    RemindersModule,
    ReviewsModule,
    DashboardReviewsModule,
    VerificationModule,
    // Feature modules (staff/chair roster CRUD, payments, admin) are added in later phases per
    // PROJECT_STRUCTURE.md.
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Default-deny: every route requires a valid access token unless marked @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Runs after JwtAuthGuard; enforces @Roles() where present.
    { provide: APP_GUARD, useClass: RolesGuard },
    // No-ops on any route not marked @Idempotent() — see IdempotencyInterceptor's own docs.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
