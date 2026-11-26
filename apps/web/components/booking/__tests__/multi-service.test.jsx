import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { BookingFlow } from '../BookingFlow';
import { apiFetch } from '../../../lib/api';

// Multi-service booking core mission — CASE 12: adding/removing a service on web must clear any
// already-selected slot and re-fetch availability against the FULL updated selection, never a
// stale one-service (or now-removed) interval.
jest.mock('../../../lib/api', () => ({ apiFetch: jest.fn(), ApiError: class ApiError extends Error {} }));
// PR #75 (production customer-session booking gate) — BookingFlow now also checks
// hasCustomerBookingSession(authStatus, user); this suite is about multi-service selection
// behavior for an already-established CUSTOMER session, not the gate itself (see
// booking-session.test.jsx for that), so the mock user is a plain CUSTOMER-audience session.
jest.mock('../../../lib/auth-context', () => ({
  useAuth: () => ({ status: 'authenticated', user: { audience: require('@barbercue/shared').SessionAudience.CUSTOMER } }),
}));
jest.mock('../../../lib/idempotency', () => ({ newIdempotencyKey: () => '12345678-1234-4567-8910-123456789012' }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ children }) => <a>{children}</a> }));
jest.mock('../../ui/Button', () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock('../../auth/GoogleIdentityButton', () => ({ GoogleIdentityButton: () => null }));
// StaffStep/DateStep are mocked to auto-advance; ServiceStep and the confirm-step summary render
// for real, since the multi-select toggle behavior itself is exactly what this file tests.
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
// react-test-renderer's `children` on an element with nested elements (not plain text) returns
// child TestInstances, not strings — ServiceStep's option button nests the service name inside
// spans/divs, so a shallow `.children.join('')` check never matches. Collect all text recursively
// instead, matching how this suite's other tests already read rendered text via toJSON().
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  apiFetch.mockImplementation(async (path) => {
    if (path.includes('/staff')) return [];
    if (path.includes('/availability')) {
      return [{ slotStart: '2026-10-10T09:00:00.000Z', slotEnd: '2026-10-10T09:30:00.000Z', available: true, state: 'AVAILABLE' }];
    }
    if (path.includes('payment-info')) return { onlinePaymentAvailable: false };
    if (path.includes('balance')) return { balance: 0 };
    if (path.includes('cancellation-policy')) return null;
    return [];
  });
});

afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
});

it('CASE 12: selecting a slot then adding a second service clears the stale slot and re-fetches availability for the full combined selection', async () => {
  await act(async () => {
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

  // Select the first service, then advance through staff -> date -> slot.
  await act(async () => findServiceButton('Haircut').props.onClick());
  await act(async () => findButtonByText('Any staff').props.onClick());
  await act(async () => findButtonByText('Select date').props.onClick());
  await act(async () => findButtonByText('Select slot').props.onClick());

  // The slot is now selected — the Confirm step (step 5) should be visible.
  expect(tree.toJSON() ? JSON.stringify(tree.toJSON()) : '').toContain('Confirm');

  const availabilityCallsBeforeAdd = apiFetch.mock.calls.filter(([p]) => p.includes('/availability')).length;
  expect(availabilityCallsBeforeAdd).toBeGreaterThan(0);
  const lastCallBeforeAdd = apiFetch.mock.calls.filter(([p]) => p.includes('/availability')).at(-1)[0];
  expect(lastCallBeforeAdd).toContain('serviceIds=haircut');
  expect(lastCallBeforeAdd).not.toContain('beard');

  // Now add the second service — this must clear the previously selected staff/date/slot and
  // re-fetch staff + availability against BOTH services, never silently keep the stale
  // single-service slot.
  await act(async () => findServiceButton('Beard Trim').props.onClick());

  const cart = tree.root.findByProps({ 'aria-label': 'Service cart' });
  expect(textOf(cart)).toContain('Haircut');
  expect(textOf(cart)).toContain('Beard Trim');
  expect(textOf(cart)).toContain('450');
  expect(textOf(cart)).toContain('50 min total');

  // Both the staff step's "Any staff" advance and the "Select slot" advance must be gone — the
  // flow is back at the staff-selection stage rather than still showing a confirm summary for the
  // old slot with the old (now incomplete) service selection.
  expect(findButtonByText('Select slot')).toBeUndefined();
  expect(findButtonByText('Any staff')).toBeDefined();

  // Re-select staff/date/slot for the new combined selection and confirm the refetch uses both ids.
  await act(async () => findButtonByText('Any staff').props.onClick());
  await act(async () => findButtonByText('Select date').props.onClick());
  await act(async () => findButtonByText('Select slot').props.onClick());

  const lastAvailabilityCall = apiFetch.mock.calls.filter(([p]) => p.includes('/availability')).at(-1)[0];
  expect(lastAvailabilityCall).toContain('serviceIds=haircut%2Cbeard');

  // Staff-fetch builds its query string via a raw template literal (unlike the availability
  // fetch's URLSearchParams), so the comma is literal here rather than percent-encoded.
  const lastStaffCall = apiFetch.mock.calls.filter(([p]) => p.includes('/staff')).at(-1)[0];
  expect(lastStaffCall).toContain('serviceIds=haircut,beard');
});

it('CASE 12b: removing a service (deselecting it) also clears the stale slot and re-fetches for the remaining selection only', async () => {
  await act(async () => {
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

  await act(async () => findServiceButton('Haircut').props.onClick());
  await act(async () => findServiceButton('Beard Trim').props.onClick());
  await act(async () => findButtonByText('Any staff').props.onClick());
  await act(async () => findButtonByText('Select date').props.onClick());
  await act(async () => findButtonByText('Select slot').props.onClick());

  // Deselect Beard Trim by clicking it again.
  await act(async () => findServiceButton('Beard Trim').props.onClick());
  expect(findButtonByText('Select slot')).toBeUndefined();

  await act(async () => findButtonByText('Any staff').props.onClick());
  await act(async () => findButtonByText('Select date').props.onClick());
  await act(async () => findButtonByText('Select slot').props.onClick());

  const lastAvailabilityCall = apiFetch.mock.calls.filter(([p]) => p.includes('/availability')).at(-1)[0];
  expect(lastAvailabilityCall).toContain('serviceIds=haircut');
  expect(lastAvailabilityCall).not.toContain('beard');
});
