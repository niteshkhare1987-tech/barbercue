import { Prisma } from '@prisma/client';
import {
  assertOnboardingTransition,
  canOnboardingTransition,
} from './onboarding-transitions';

export interface AcceptedOnboardingInvitation {
  applicationId: string;
  reference: string;
  salonName: string;
  assignedEmployeeId: string;
}

/**
 * Called inside AuthService.resetPassword's transaction after a token is claimed. If the token
 * belongs to a salon onboarding invitation, the owner has just proved control of the invited email
 * address (the single-use link only reached that inbox) and set their own password, so:
 * the email is marked verified, the invitation ACCEPTED, and the application moves to
 * READY_TO_PUBLISH. Ordinary password resets are untouched (returns null).
 */
export async function acceptOnboardingInvitationInTx(
  tx: Prisma.TransactionClient,
  passwordResetTokenId: string,
  userId: string,
): Promise<AcceptedOnboardingInvitation | null> {
  const invitation = await tx.salonOnboardingInvitation.findUnique({
    where: { passwordResetTokenId },
    include: {
      application: {
        select: {
          id: true,
          status: true,
          reference: true,
          salonName: true,
          assignedEmployeeId: true,
        },
      },
    },
  });
  if (
    !invitation ||
    invitation.ownerUserId !== userId ||
    invitation.status === 'REVOKED'
  ) {
    return null;
  }
  const now = new Date();
  await tx.salonOnboardingInvitation.update({
    where: { id: invitation.id },
    data: { status: 'ACCEPTED', acceptedAt: now },
  });
  await tx.user.updateMany({
    where: { id: userId, emailVerifiedAt: null },
    data: { emailVerifiedAt: now },
  });
  const app = invitation.application;
  if (canOnboardingTransition('OWNER_ACTIVATED', app.status, 'SYSTEM')) {
    const next = assertOnboardingTransition(
      'OWNER_ACTIVATED',
      app.status,
      'SYSTEM',
    );
    await tx.salonOnboardingApplication.update({
      where: { id: app.id },
      data: { status: next },
    });
    await tx.salonOnboardingStatusHistory.create({
      data: {
        applicationId: app.id,
        previousStatus: app.status,
        newStatus: next,
        actorId: userId,
        reason: 'Owner accepted the invitation and set a password',
      },
    });
  }
  return {
    applicationId: app.id,
    reference: app.reference,
    salonName: app.salonName,
    assignedEmployeeId: app.assignedEmployeeId,
  };
}
