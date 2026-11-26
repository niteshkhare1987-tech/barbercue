import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { BookingFlow } from '../BookingFlow';
import { apiFetch } from '../../../lib/api';
import { trackMetaPixel } from '../../../lib/meta-pixel';

// PR #73 (multi-service booking) x PR #75 (customer-session booking gate) integration — proves
// the two features compose correctly rather than one silently undoing the other:
//   - a STAFF/ADMIN session must never be able to create a booking or fetch customer credits,
//     no matter how many services are selected
//   - completing "Continue as customer" (Google sign-in) must preserve every already-made
//     multi-service selection (services, staff, date, slot) rather than resetting the wizard
//   - adding/removing a service still invalidates a stale slot once the auth gate is in place
// See booking-session.test.jsx for the underlying hasCustomerBookingSession unit coverage, kept
// unmodified — this file is about the COMPOSED behavior inside BookingFlow itself.
// A tiny external store (React's own officially-supported pattern via useSyncExternalStore) so
// this mock genuinely notifies BookingFlow of an auth change and forces a real re-render — the
// same guarantee the real AuthContext's setUser gets for free from React context propagation,
// which a plain mutated closure variable does NOT get (a component only re-renders in response to
// its OWN state/props/context changing, never because some unrelated external variable changed).
let mockAuthState = { status: 'authenticated', user: { audience: 'CUSTOMER' } };
const mockAuthListeners = new Set();
function setMockAuthState(next) {
  mockAuthState = next;
  mockAuthListeners.forEach((listener) => listener());
}
const mockGoogleLogin = jest.fn();

jest.mock('../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class ApiError extends Error {} }));
jest.mock('../../../lib/meta-pixel', () => ({ trackMetaPixel: jest.fn() }));
jest.mock('../../../lib/auth-context', () => {
  const { useSyncExternalStore } = require('react');
  return {
    useAuth: () => {
      const state = useSyncExternalStore(
        (listener) => {
          mockAuthListeners.add(listener);
          return () => mockAuthListeners.delete(listener);
        },
        () => mockAuthState,
      );
      return { ...state, googleLogin: mockGoogleLogin };
    },
  };
});
jest.mock('../../../lib/idempotency', () => ({ newIdempotencyKey: () => '12345678-1234-4567-8910-123456789012' }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }) => <a>{children}</a> }));
jest.mock('../../ui/Button', () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock('../../auth/GoogleIdentityButton', () => ({
  GoogleIdentityButton: ({ onCredential }) => (
    <button onClick={() => onCredential('fake-id-token')}>Continue as customer</button>
  ),
}));
// StaffStep/DateStep/SlotStep auto-advance; ServiceStep and the auth gating itself render for
// real, since both the multi-select toggle behavior and the isCustomerSession composition are
// exactly what this file tests.
jest.mock('../StaffStep', () => ({
  StaffStep: ({ onSelect }) => <button onClick={() => onSelect(null)}>Any staff</button>,
}));
jest.mock('../DateStep', () => ({ DateStep: ({ onSelect }) => <button onClick={() => onSelect('2026-10-10')}>Select date</button> }));
jest.mock('../SlotStep', () => ({
  SlotStep: ({ slots, onSelect }) =>
    slots.length > 0 ? (
      <button onClick={() => onSelect(slots[0])}>Select slot</button>
    ) : (
      <span>No slots</span>
    ),
}));
jest.mock('../CancelBookingDialog', () => ({ CancelBookingDialog: () => null }));
jest.mock('../RescheduleBookingDialog', () => ({ RescheduleBookingDialog: () => null }));
jest.mock('../BookingActionsBar', () => ({ BookingActionsBar: () => null }));
jest.mock('../../queue/CheckInPanel', () => ({ canCheckIn: () => false, CheckInPanel: () => null }));

const services = [
  { id: 'haircut', name: 'Haircut', durationMinutes: 30, price: 300 },
  { id: 'beard', name: 'Beard Trim', durationMinutes: 20, price: 150 },
];

let tree;
// Same recursive text-collection helper as multi-service.test.jsx — ServiceStep/Button nest the
// visible text inside spans/divs, so a shallow `.children.join('')` never matches.
function textOf(instance) {
  return instance.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}
function findServiceButton(name) {
  return tree.root.findAllByType('button').find((b) => textOf(b).includes(name));
}
function findButtonByText(text) {
  return tree.root.findAllByType('button').find((b) => textOf(b) === text);
}

function renderFlow() {
  return act(async () => {
    tree = TestRenderer.create(
      <BookingFlow
        salonId="s1"
        services={services}
        operatingHours={[]}
        currency="INR"
        countryCode="IN"
        salonTimezone="Asia/Kolkata"
      />,
    );
  });
}

// handleGoogleCredential fires its onCredential handler with `void handleGoogleCredential(...)`
// (fire-and-forget from the click's own perspective), so the click's own `act()` call resolves
// before the awaited googleLogin()/setGoogleSubmitting(false) chain inside it has actually run.
// A couple of extra microtask ticks inside a fresh `act()` lets that pending chain settle.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectTwoServicesThroughToConfirm() {
  await act(async () => findServiceButton('Haircut').props.onClick());
  await act(async () => findServiceButton('Beard Trim').props.onClick());
  await act(async () => findButtonByText('Any staff').props.onClick());
  await act(async () => findButtonByText('Select date').props.onClick());
  await act(async () => findButtonByText('Select slot').props.onClick());
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  setMockAuthState({ status: 'authenticated', user: { audience: 'CUSTOMER' } });
  apiFetch.mockImplementation(async (path, opts) => {
    if (opts?.method === 'POST') {
      return {
        id: 'booking1',
        status: 'CONFIRMED',
        serviceName: 'Haircut + Beard Trim',
        services: [
          { serviceId: 'haircut', name: 'Haircut', durationMinutes: 30, price: 300 },
          { serviceId: 'beard', name: 'Beard Trim', durationMinutes: 20, price: 150 },
        ],
        salonName: 'Test Salon',
        slotStart: '2026-10-10T09:00:00.000Z',
        slotEnd: '2026-10-10T10:20:00.000Z',
        salonTimezone: 'Asia/Kolkata',
        payableAmount: 450,
        creditsRedeemedAmount: null,
        prepaymentRequiredAmount: null,
        checkInOpensAt: null,
        checkInDueBy: null,
        selectedStyleName: null,
      };
    }
    if (path.includes('/staff')) return [];
    if (path.includes('/availability')) {
      return [{ slotStart: '2026-10-10T09:00:00.000Z', slotEnd: '2026-10-10T09:30:00.000Z', available: true, state: 'AVAILABLE' }];
    }
    if (path.includes('payment-info')) return { onlinePaymentAvailable: false };
    if (path.includes('balance')) return { balance: 100 };
    if (path.includes('cancellation-policy')) return null;
    return [];
  });
});

afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});

it('A: CUSTOMER audience with multiple services selected can confirm the booking', async () => {
  setMockAuthState({ status: 'authenticated', user: { audience: 'CUSTOMER' } });
  await renderFlow();
  await selectTwoServicesThroughToConfirm();

  expect(findButtonByText('Confirm booking')).toBeDefined();
  expect(trackMetaPixel.mock.calls).toEqual([['InitiateCheckout']]);
  await act(async () => findButtonByText('Confirm booking').props.onClick());
  expect(trackMetaPixel.mock.calls).toEqual([['InitiateCheckout'], ['Schedule', 'booking1']]);

  const postCall = apiFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
  expect(postCall).toBeDefined();
  const body = JSON.parse(postCall[1].body);
  expect(body.serviceIds).toEqual(['haircut', 'beard']);
});

it.each(['failed', 'pending payment'])('does not report a Schedule for a %s booking', async (outcome) => {
  const defaultFetch = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async (path, opts) => {
    if (opts?.method !== 'POST') return defaultFetch(path, opts);
    if (outcome === 'failed') throw new Error('Booking not created');
    return { ...await defaultFetch(path, opts), status: 'PENDING_PAYMENT' };
  });
  await renderFlow();
  await selectTwoServicesThroughToConfirm();
  await act(async () => findButtonByText('Confirm booking').props.onClick());
  expect(trackMetaPixel.mock.calls).toEqual([['InitiateCheckout']]);
});

it.each([['STAFF'], ['ADMIN']])(
  'B/C: %s audience with multiple services selected cannot confirm the booking (POST blocked)',
  async (audience) => {
    setMockAuthState({ status: 'authenticated', user: { audience } });
    await renderFlow();
    await selectTwoServicesThroughToConfirm();

    // The Confirm button never even renders for a non-customer session — "Continue as customer"
    // is offered instead (defense in depth: handleConfirmBooking itself also checks
    // isCustomerSession, so even a stray call could never reach the POST).
    expect(findButtonByText('Confirm booking')).toBeUndefined();
    expect(findButtonByText('Continue as customer')).toBeDefined();

    const postCall = apiFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
    expect(postCall).toBeUndefined();
  },
);

it.each([['STAFF'], ['ADMIN']])('D: a %s session never fetches the customer credits balance', async (audience) => {
  setMockAuthState({ status: 'authenticated', user: { audience } });
  await renderFlow();
  await selectTwoServicesThroughToConfirm();

  const balanceCall = apiFetch.mock.calls.find(([path]) => path.includes('balance'));
  expect(balanceCall).toBeUndefined();
});

it('E: after "Continue as customer" succeeds, the multi-service selection survives and the same appointment can be confirmed', async () => {
  setMockAuthState({ status: 'authenticated', user: { audience: 'STAFF' } });
  await renderFlow();
  await selectTwoServicesThroughToConfirm();

  // Still gated — confirms this genuinely started from a non-customer session.
  expect(findButtonByText('Confirm booking')).toBeUndefined();
  expect(findButtonByText('Continue as customer')).toBeDefined();

  // "Continue as customer" -> Google sign-in succeeds -> the session's audience becomes CUSTOMER,
  // exactly like AuthService.googleLogin does in production for a linked owner/staff identity —
  // setMockAuthState notifies BookingFlow's useSyncExternalStore subscription, forcing the same
  // kind of re-render a real AuthContext update would.
  mockGoogleLogin.mockImplementation(async () => {
    setMockAuthState({ status: 'authenticated', user: { audience: 'CUSTOMER' } });
  });
  await act(async () => findButtonByText('Continue as customer').props.onClick());
  await flush();

  // The exact same multi-service appointment — never reset to the picker's first step, and never
  // re-fetched from scratch (services/staff/date/slot all held in this same component instance,
  // exactly as the doc comment on handleGoogleCredential describes).
  expect(findButtonByText('Confirm booking')).toBeDefined();
  await act(async () => findButtonByText('Confirm booking').props.onClick());

  const postCall = apiFetch.mock.calls.find(([, opts]) => opts?.method === 'POST');
  expect(postCall).toBeDefined();
  const body = JSON.parse(postCall[1].body);
  expect(body.serviceIds).toEqual(['haircut', 'beard']);
  expect(body.slotStart).toBe('2026-10-10T09:00:00.000Z');
});

it('F: adding/removing a service still clears a stale slot once the customer-session gate is composed in', async () => {
  setMockAuthState({ status: 'authenticated', user: { audience: 'CUSTOMER' } });
  await renderFlow();
  await selectTwoServicesThroughToConfirm();
  expect(findButtonByText('Confirm booking')).toBeDefined();

  // Removing a service invalidates the stale staff/date/slot — back to the staff step, not still
  // showing Confirm for a selection that no longer matches.
  await act(async () => findServiceButton('Beard Trim').props.onClick());
  expect(findButtonByText('Confirm booking')).toBeUndefined();
  expect(findButtonByText('Any staff')).toBeDefined();
});
