import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { usePathname } from 'next/navigation';
import { SiteHeader } from '../SiteHeader';
import { useAuth } from '../../../lib/auth-context';

jest.mock('next/navigation', () => ({ usePathname: jest.fn(), useRouter: () => ({ push: jest.fn() }) }));
jest.mock('../../../lib/auth-context', () => ({ useAuth: jest.fn() }));
jest.mock('../../../lib/api', () => ({ apiFetch: jest.fn(() => Promise.resolve([])) }));
jest.mock('../NotificationBell', () => ({ NotificationBell: () => null }));
jest.mock('../../ui/BrandLockup', () => ({ BrandLockup: () => null }));
// Preserves href and onClick — these tests assert destinations and that every link closes the menu.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className, onClick }) => (
    <a href={href} className={className} onClick={onClick}>{children}</a>
  ),
}));

// The public site's mobile menu lives in SiteHeader (mounted from app/layout.tsx).
// components/landing/LandingMobileNav.tsx is not imported anywhere and never renders.
const focusToggle = jest.fn();

function render(pathname = '/') {
  usePathname.mockReturnValue(pathname);
  let tree;
  act(() => {
    tree = TestRenderer.create(<SiteHeader />, {
      createNodeMock: (el) => (el.type === 'button' ? { focus: focusToggle } : null),
    });
  });
  return tree;
}
const toggleOf = (tree) => tree.root.find((n) => n.type === 'button' && 'aria-expanded' in n.props);
const mobileNavOf = (tree) => tree.root.findAll((n) => n.type === 'nav' && n.props['aria-label'] === 'Mobile')[0];
const label = (a) => a.children.join('');
const open = (tree) => act(() => toggleOf(tree).props.onClick());

describe('SiteHeader mobile navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.mockReturnValue({ user: null, status: 'unauthenticated' });
  });

  it('starts closed with a labelled, collapsed toggle', () => {
    const tree = render();
    expect(toggleOf(tree).props['aria-expanded']).toBe(false);
    expect(toggleOf(tree).props['aria-label']).toBe('Open menu');
    expect(mobileNavOf(tree)).toBeUndefined();
  });

  it('opens and closes from the toggle, and the toggle points at the menu it controls', () => {
    const tree = render();
    open(tree);
    const nav = mobileNavOf(tree);
    expect(nav).toBeDefined();
    expect(toggleOf(tree).props['aria-expanded']).toBe(true);
    expect(toggleOf(tree).props['aria-label']).toBe('Close menu');
    expect(nav.props.id).toBeTruthy();
    expect(toggleOf(tree).props['aria-controls']).toBe(nav.props.id);

    act(() => toggleOf(tree).props.onClick());
    expect(mobileNavOf(tree)).toBeUndefined();
  });

  it('keeps the existing links, labels and destinations for a signed-out visitor', () => {
    const tree = render();
    open(tree);
    const links = mobileNavOf(tree).findAllByType('a').map((a) => [label(a), a.props.href]);
    expect(links).toEqual([
      ['Find a barber', '/search'],
      ['Services', '/#services'],
      ['How it works', '/#book-or-queue'],
      ['For shops', '/#for-shops'],
      ['About Us', '/about-us'],
      ['Employee Login', '/employee/login'],
      ['Contact Us', '/contact-us'],
      ["We're Hiring", '/careers'],
      ['Sign In', '/login'],
      ['List your shop', '/dashboard/register-shop'],
    ]);
  });

  // REGRESSION: Employee Login, Contact Us and We're Hiring had no close handler, so tapping the
  // link for the page you were already on (no pathname change) left the menu open over the page.
  it.each(['Find a barber', 'Services', 'About Us', 'Employee Login', 'Contact Us', "We're Hiring", 'Sign In', 'List your shop'])(
    'REGRESSION: closes the menu when "%s" is tapped, even on the page it links to',
    (linkLabel) => {
      const tree = render('/contact-us');
      open(tree);
      const link = mobileNavOf(tree).findAllByType('a').find((a) => label(a) === linkLabel);
      act(() => link.props.onClick?.());
      expect(mobileNavOf(tree)).toBeUndefined();
      expect(toggleOf(tree).props['aria-expanded']).toBe(false);
    },
  );

  // REGRESSION: Escape did nothing, so keyboard users had to Shift+Tab back to the toggle.
  it('REGRESSION: Escape closes the open menu and returns focus to the toggle', () => {
    const tree = render();
    open(tree);
    const host = toggleOf(tree).parent;
    const event = { key: 'Escape', preventDefault: jest.fn() };
    act(() => host.props.onKeyDown(event));
    expect(mobileNavOf(tree)).toBeUndefined();
    expect(toggleOf(tree).props['aria-expanded']).toBe(false);
    expect(focusToggle).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys and does not steal focus when the menu is already closed', () => {
    const tree = render();
    open(tree);
    const host = toggleOf(tree).parent;
    act(() => host.props.onKeyDown({ key: 'Tab', preventDefault: jest.fn() }));
    expect(mobileNavOf(tree)).toBeDefined();

    act(() => toggleOf(tree).props.onClick());
    act(() => host.props.onKeyDown({ key: 'Escape', preventDefault: jest.fn() }));
    expect(focusToggle).not.toHaveBeenCalled();
  });

  it('closes when the route changes', () => {
    const tree = render('/');
    open(tree);
    usePathname.mockReturnValue('/search');
    act(() => tree.update(<SiteHeader />));
    expect(mobileNavOf(tree)).toBeUndefined();
  });
});
