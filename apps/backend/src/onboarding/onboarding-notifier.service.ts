import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { NotificationType } from '@barbercue/shared';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Roles that review onboarding applications and so hear about submissions/activations. */
export const ONBOARDING_DECISION_ROLES: Role[] = [
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
];

/**
 * In-app notices for the onboarding workflow. In-app rows are the only channel FastQue can
 * actually deliver today; they are written after the workflow change commits, and a failure here
 * is logged rather than undoing the workflow change it describes.
 */
@Injectable()
export class OnboardingNotifierService {
  private readonly logger = new Logger(OnboardingNotifierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async toAdmins(
    type: NotificationType,
    applicationId: string,
    payload: Record<string, unknown>,
    excludeUserId?: string,
  ): Promise<void> {
    const admins = await this.prisma.userRole.findMany({
      where: {
        role: { in: ONBOARDING_DECISION_ROLES },
        salonId: null,
        user: { status: 'ACTIVE', deletedAt: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    await Promise.all(
      admins
        .filter((a) => a.userId !== excludeUserId)
        .map((a) =>
          this.send(
            a.userId,
            type,
            payload,
            `admin/onboarding/${applicationId}`,
          ),
        ),
    );
  }

  async toEmployee(
    employeeProfileId: string,
    type: NotificationType,
    applicationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const profile = await this.prisma.employeeProfile.findUnique({
      where: { id: employeeProfileId },
      select: { userId: true },
    });
    if (!profile) return;
    await this.send(
      profile.userId,
      type,
      payload,
      `employee/onboarding/${applicationId}`,
    );
  }

  async toUser(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    deepLink?: string,
  ): Promise<void> {
    await this.send(userId, type, payload, deepLink);
  }

  private async send(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    deepLink?: string,
  ): Promise<void> {
    try {
      await this.notifications.notify(userId, type, payload, deepLink);
    } catch (err) {
      this.logger.warn(
        `In-app notification ${type} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}
