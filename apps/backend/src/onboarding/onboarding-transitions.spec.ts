import {
  assertOnboardingTransition,
  canOnboardingTransition,
} from './onboarding-transitions';

describe('onboarding transitions', () => {
  it('submits a draft and resubmits after a change request', () => {
    expect(assertOnboardingTransition('SUBMIT', 'DRAFT', 'EMPLOYEE')).toBe(
      'SUBMITTED',
    );
    expect(
      assertOnboardingTransition('SUBMIT', 'CHANGES_REQUESTED', 'EMPLOYEE'),
    ).toBe('RESUBMITTED');
  });

  it('never lets an employee approve, reject, request changes or publish', () => {
    for (const action of [
      'APPROVE',
      'REJECT',
      'REQUEST_CHANGES',
      'AUTHORIZE_PUBLISH',
      'START_REVIEW',
    ] as const) {
      expect(canOnboardingTransition(action, 'SUBMITTED', 'EMPLOYEE')).toBe(
        false,
      );
      expect(() =>
        assertOnboardingTransition(action, 'SUBMITTED', 'EMPLOYEE'),
      ).toThrow('You are not allowed to perform this action.');
    }
  });

  it('only approves applications awaiting review', () => {
    expect(assertOnboardingTransition('APPROVE', 'UNDER_REVIEW', 'ADMIN')).toBe(
      'APPROVED',
    );
    expect(assertOnboardingTransition('APPROVE', 'RESUBMITTED', 'ADMIN')).toBe(
      'APPROVED',
    );
    for (const from of [
      'DRAFT',
      'CHANGES_REQUESTED',
      'REJECTED',
      'APPROVED',
      'ACTIVE',
    ] as const) {
      expect(canOnboardingTransition('APPROVE', from, 'ADMIN')).toBe(false);
    }
  });

  it('cannot submit while under review or after a decision', () => {
    for (const from of [
      'SUBMITTED',
      'UNDER_REVIEW',
      'RESUBMITTED',
      'APPROVED',
      'REJECTED',
    ] as const) {
      expect(canOnboardingTransition('SUBMIT', from, 'EMPLOYEE')).toBe(false);
    }
  });

  it('keeps approval, activation and publication as separate stages', () => {
    expect(canOnboardingTransition('PUBLISHED', 'SUBMITTED', 'SYSTEM')).toBe(
      false,
    );
    expect(canOnboardingTransition('PUBLISHED', 'DRAFT', 'SYSTEM')).toBe(false);
    expect(
      assertOnboardingTransition('INVITE_SENT', 'APPROVED', 'SYSTEM'),
    ).toBe('AWAITING_OWNER_ACTIVATION');
    expect(
      assertOnboardingTransition('INVITE_FAILED', 'APPROVED', 'SYSTEM'),
    ).toBe('OWNER_INVITED');
    expect(
      assertOnboardingTransition('INVITE_SENT', 'OWNER_INVITED', 'SYSTEM'),
    ).toBe('AWAITING_OWNER_ACTIVATION');
    expect(
      assertOnboardingTransition(
        'OWNER_ACTIVATED',
        'AWAITING_OWNER_ACTIVATION',
        'SYSTEM',
      ),
    ).toBe('READY_TO_PUBLISH');
    expect(
      assertOnboardingTransition('PUBLISHED', 'READY_TO_PUBLISH', 'SYSTEM'),
    ).toBe('ACTIVE');
    expect(assertOnboardingTransition('SUSPEND', 'ACTIVE', 'ADMIN')).toBe(
      'SUSPENDED',
    );
  });
});
