import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { Role } from '@barbercue/shared';
import { LandingHeaderActions } from '../LandingHeaderActions';
import { useAuth } from '../../../lib/auth-context';

jest.mock('../../../lib/auth-context', () => ({ useAuth: jest.fn() }));
// Preserves href (unlike the repo's other next/link mock) — these tests assert exact destinations.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className }) => <a href={href} className={className}>{children}</a>,
}));

function links(variant) {
  let tree;
  act(() => { tree = TestRenderer.create(<LandingHeaderActions variant={variant} />); });
  return tree.root.findAllByType('a');
}
const labelsOf = (anchors) => anchors.map((a) => a.children.join(''));
const hrefOf = (anchors, label) => anchors.find((a) => a.children.join('') === label)?.props.href;

// Golden-path regression (P0 register-shop incident). ROOT CAUSE: the desktop "wide" header's
// "List Your Shop" CTA — FastQue's only prominent shop-registration entry point — was hidden for
// EVERY authenticated user, not just existing workspace users. RegisterShopPage grants any
// authenticated user (a customer included) the self-serve upgrade to SALON_OWNER, so a signed-in
// customer lost the only visible path into shop onboarding and saw just their "My account" link
// instead. Fixed by scoping the hide to actual workspace users (owner/staff/admin), who already
// have their own dashboard link and don't need a second onboarding entry point.
describe('LandingHeaderActions "wide" (desktop header)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows Sign In + List Your Shop -> /dashboard/register-shop for an unauthenticated visitor', () => {
    useAuth.mockReturnValue({ user: null, status: 'unauthenticated' });
    const anchors = links('wide');
    expect(labelsOf(anchors)).toEqual(expect.arrayContaining(['Sign In', 'List Your Shop']));
    expect(hrefOf(anchors, 'List Your Shop')).toBe('/dashboard/register-shop');
  });

  it('REGRESSION: keeps List Your Shop visible for an already-authenticated plain customer', () => {
    useAuth.mockReturnValue({ user: { roles: [Role.CUSTOMER] }, status: 'authenticated' });
    const anchors = links('wide');
    expect(hrefOf(anchors, 'List Your Shop')).toBe('/dashboard/register-shop');
    // The account link is additive, not a replacement — a signed-in customer keeps both.
    expect(hrefOf(anchors, 'My account')).toBe('/account');
  });

  it('preserves existing behaviour: no duplicate onboarding entry point for an existing owner', () => {
    useAuth.mockReturnValue({ user: { roles: [Role.SALON_OWNER] }, status: 'authenticated' });
    const anchors = links('wide');
    expect(labelsOf(anchors)).not.toContain('List Your Shop');
    expect(hrefOf(anchors, 'Owner dashboard')).toBe('/dashboard/salons');
  });

  it('preserves existing behaviour: no duplicate onboarding entry point for staff', () => {
    useAuth.mockReturnValue({ user: { roles: [Role.SALON_STAFF] }, status: 'authenticated' });
    const anchors = links('wide');
    expect(labelsOf(anchors)).not.toContain('List Your Shop');
    expect(hrefOf(anchors, 'Back to dashboard')).toBe('/dashboard/salons');
  });

  it('preserves existing behaviour: no duplicate onboarding entry point for a platform admin', () => {
    useAuth.mockReturnValue({ user: { roles: [Role.PLATFORM_ADMIN] }, status: 'authenticated' });
    const anchors = links('wide');
    expect(labelsOf(anchors)).not.toContain('List Your Shop');
    expect(hrefOf(anchors, 'Admin dashboard')).toBe('/dashboard/admin');
  });

  it('shows List Your Shop while the session is still restoring (never blank for a real visitor)', () => {
    useAuth.mockReturnValue({ user: null, status: 'loading' });
    expect(hrefOf(links('wide'), 'List Your Shop')).toBe('/dashboard/register-shop');
  });
});

describe('LandingHeaderActions "utility" (unrelated Sign Up CTA — must NOT change)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows Login + Sign Up for an unauthenticated visitor', () => {
    useAuth.mockReturnValue({ user: null, status: 'unauthenticated' });
    expect(labelsOf(links('utility'))).toEqual(expect.arrayContaining(['Login', 'Sign Up']));
  });

  it('still hides Sign Up for an authenticated customer (this CTA is unrelated to shop onboarding)', () => {
    useAuth.mockReturnValue({ user: { roles: [Role.CUSTOMER] }, status: 'authenticated' });
    expect(labelsOf(links('utility'))).not.toContain('Sign Up');
  });
});
