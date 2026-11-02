import { HttpStatus } from '@nestjs/common';
import { OnboardingErrorCode, type OnboardingStatus } from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';

/** Who is allowed to drive a transition. Employees never approve, reject or publish. */
export type OnboardingActor = 'EMPLOYEE' | 'ADMIN' | 'SYSTEM';

export type OnboardingAction =
  | 'SUBMIT'
  | 'START_REVIEW'
  | 'REQUEST_CHANGES'
  | 'REJECT'
  | 'APPROVE'
  | 'INVITE_SENT'
  | 'INVITE_FAILED'
  | 'OWNER_ACTIVATED'
  | 'AUTHORIZE_PUBLISH'
  | 'PUBLISHED'
  | 'SUSPEND'
  | 'REINSTATE';

interface TransitionRule {
  actor: OnboardingActor;
  from: readonly OnboardingStatus[];
  /** null = computed by the caller (SUBMIT -> SUBMITTED or RESUBMITTED). */
  to: OnboardingStatus | null;
}

const POST_APPROVAL: readonly OnboardingStatus[] = [
  'APPROVED',
  'OWNER_INVITED',
  'AWAITING_OWNER_ACTIVATION',
  'READY_TO_PUBLISH',
];

export const ONBOARDING_TRANSITIONS: Record<OnboardingAction, TransitionRule> =
  {
    SUBMIT: {
      actor: 'EMPLOYEE',
      from: ['DRAFT', 'CHANGES_REQUESTED'],
      to: null,
    },
    START_REVIEW: {
      actor: 'ADMIN',
      from: ['SUBMITTED', 'RESUBMITTED'],
      to: 'UNDER_REVIEW',
    },
    REQUEST_CHANGES: {
      actor: 'ADMIN',
      from: ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'],
      to: 'CHANGES_REQUESTED',
    },
    REJECT: {
      actor: 'ADMIN',
      from: ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'],
      to: 'REJECTED',
    },
    APPROVE: {
      actor: 'ADMIN',
      from: ['SUBMITTED', 'UNDER_REVIEW', 'RESUBMITTED'],
      to: 'APPROVED',
    },
    // Invitation outcomes. A failed send keeps the salon approved so the admin can retry.
    INVITE_SENT: {
      actor: 'SYSTEM',
      from: ['APPROVED', 'OWNER_INVITED'],
      to: 'AWAITING_OWNER_ACTIVATION',
    },
    INVITE_FAILED: { actor: 'SYSTEM', from: ['APPROVED'], to: 'OWNER_INVITED' },
    OWNER_ACTIVATED: {
      actor: 'SYSTEM',
      from: ['APPROVED', 'OWNER_INVITED', 'AWAITING_OWNER_ACTIVATION'],
      to: 'READY_TO_PUBLISH',
    },
    // Publication is an explicit admin decision and only ever follows approval.
    AUTHORIZE_PUBLISH: { actor: 'ADMIN', from: POST_APPROVAL, to: null },
    PUBLISHED: { actor: 'SYSTEM', from: POST_APPROVAL, to: 'ACTIVE' },
    SUSPEND: { actor: 'ADMIN', from: ['ACTIVE'], to: 'SUSPENDED' },
    REINSTATE: { actor: 'ADMIN', from: ['SUSPENDED'], to: 'ACTIVE' },
  };

/** Throws unless `actor` may perform `action` from `from`; returns the target status. */
export function assertOnboardingTransition(
  action: OnboardingAction,
  from: OnboardingStatus,
  actor: OnboardingActor,
): OnboardingStatus {
  const rule = ONBOARDING_TRANSITIONS[action];
  if (rule.actor !== actor) {
    throw new AppException(
      OnboardingErrorCode.INVALID_TRANSITION,
      'You are not allowed to perform this action.',
      HttpStatus.FORBIDDEN,
    );
  }
  if (!rule.from.includes(from)) {
    throw new AppException(
      OnboardingErrorCode.INVALID_TRANSITION,
      `This application is ${from.toLowerCase().replace(/_/g, ' ')} and cannot be changed this way.`,
      HttpStatus.CONFLICT,
    );
  }
  if (action === 'SUBMIT') {
    return from === 'CHANGES_REQUESTED' ? 'RESUBMITTED' : 'SUBMITTED';
  }
  return rule.to ?? from;
}

export function canOnboardingTransition(
  action: OnboardingAction,
  from: OnboardingStatus,
  actor: OnboardingActor,
): boolean {
  try {
    assertOnboardingTransition(action, from, actor);
    return true;
  } catch {
    return false;
  }
}
