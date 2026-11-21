import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { Role } from '@barbercue/shared';
import { AdminShell } from '../AdminShell';
import { ADMIN_NAV_GROUPS, ADMIN_NAV_ITEMS, activeAdminItem, adminNavFor, adminNavGroupsFor, selectedAdminGroup } from '../admin-nav';

let pathname = '/dashboard/admin';
let search = '';
let roles = [Role.PLATFORM_ADMIN];
let drawerLayout = false;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, className, ...rest }) => <a href={href} className={className} {...rest}>{children}</a>,
}));
jest.mock('../../../../lib/auth-context', () => ({
  useAuth: () => ({ user: { email: 'admin@fastque.test', roles }, logout: jest.fn() }),
}));
jest.mock('../../../layout/NotificationBell', () => ({ NotificationBell: () => null }));
jest.mock('../../../assistant/ActionAssistant', () => ({ ActionAssistant: () => null }));
jest.mock('../../../ui/BrandLockup', () => ({ BrandLockup: () => null }));

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''));

function render() {
  let tree;
  act(() => {
    tree = TestRenderer.create(<AdminShell><p>page</p></AdminShell>);
  });
  return tree;
}
const rail = (tree) => tree.root.findByProps({ 'aria-label': 'Sections' }).findAllByType('button');
const railButton = (tree, label) => rail(tree).find((b) => b.props['aria-label'] === label);
const subnav = (tree) => tree.root.findByProps({ 'aria-labelledby': 'admin-subnav-title' });
const subnavLinks = (tree) => subnav(tree).findAllByType('a').map((a) => textOf(a));
// Link text as rendered: planned pages carry a "Planned" badge after the label.
const groupLabels = (id, r = roles) =>
  adminNavFor(r).filter((i) => i.group === id).map((i) => (i.status === 'planned' ? `${i.label}Planned` : i.label));

beforeEach(() => {
  pathname = '/dashboard/admin/inventory/upload';
  search = '';
  roles = [Role.PLATFORM_ADMIN];
  drawerLayout = false;
  const store = {};
  globalThis.window = {
    sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    matchMedia: () => ({ matches: drawerLayout }),
  };
  globalThis.document = { body: { style: {} }, addEventListener: jest.fn(), removeEventListener: jest.fn() };
});
afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
});

describe('admin shell: rail sections drive the sub-sidebar', () => {
  it('opens on the section that holds the current page and lists only its pages', () => {
    const tree = render();
    expect(railButton(tree, 'Inventory').props['aria-pressed']).toBe(true);
    expect(railButton(tree, 'Inventory').props['aria-current']).toBe('location');
    expect(rail(tree).filter((b) => b.props['aria-pressed'])).toHaveLength(1);

    expect(textOf(tree.root.findByProps({ id: 'admin-subnav-title' }))).toBe('Inventory');
    expect(subnavLinks(tree)).toEqual(groupLabels('INVENTORY'));
    expect(subnavLinks(tree)).not.toContain('Overview'); // Finance's first page
    const current = subnav(tree).findAll((n) => n.type === 'a' && n.props['aria-current'] === 'page');
    expect(current.map(textOf)).toEqual(['Upload Inventory']);
  });

  it('switches the sub-sidebar when another section is picked, without navigating', () => {
    const tree = render();
    act(() => railButton(tree, 'Finance').props.onClick());

    expect(railButton(tree, 'Finance').props['aria-pressed']).toBe(true);
    expect(railButton(tree, 'Inventory').props['aria-pressed']).toBe(false);
    // The section holding the open page stays marked while another one is browsed.
    expect(railButton(tree, 'Inventory').props['aria-current']).toBe('location');
    expect(subnavLinks(tree)).toEqual(groupLabels('FINANCE'));
    expect(subnav(tree).findAll((n) => n.props['aria-current'] === 'page')).toHaveLength(0);
  });

  it('follows the page again after navigation', () => {
    const tree = render();
    act(() => railButton(tree, 'Settings').props.onClick());
    expect(textOf(tree.root.findByProps({ id: 'admin-subnav-title' }))).toBe('Settings');

    pathname = '/dashboard/admin/analytics/chart-builder';
    search = 'preset=bookings';
    act(() => tree.update(<AdminShell><p>page</p></AdminShell>));
    expect(railButton(tree, 'Bookings').props['aria-pressed']).toBe(true);
    expect(subnavLinks(tree)).toEqual(groupLabels('BOOKINGS'));
    const current = subnav(tree).findAll((n) => n.type === 'a' && n.props['aria-current'] === 'page');
    expect(current.map(textOf)).toEqual(['Booking Trends']);
  });

  it('opens the drawer from the rail in the tablet layout, and a second press closes it', () => {
    drawerLayout = true;
    const tree = render();
    const menu = () => tree.root.findByProps({ 'aria-controls': 'admin-sidebar', 'aria-label': 'Open navigation' });
    expect(menu().props['aria-expanded']).toBe(false);
    act(() => railButton(tree, 'Staff').props.onClick());
    expect(menu().props['aria-expanded']).toBe(true);
    expect(subnavLinks(tree)).toEqual(groupLabels('STAFF'));
    act(() => railButton(tree, 'Staff').props.onClick());
    expect(menu().props['aria-expanded']).toBe(false);
  });

  it('offers a section picker inside the drawer for phones (no rail there)', () => {
    const tree = render();
    const picker = tree.root.findByProps({ id: 'admin-group-picker' });
    expect(picker.props.value).toBe('INVENTORY');
    act(() => picker.props.onChange({ target: { value: 'CUSTOMERS' } }));
    expect(tree.root.findByProps({ id: 'admin-group-picker' }).props.value).toBe('CUSTOMERS');
    expect(subnavLinks(tree)).toEqual(groupLabels('CUSTOMERS'));
  });

  it('hides sections the role cannot open anything in', () => {
    roles = [Role.HR_ADMIN];
    pathname = '/dashboard/admin/employees';
    const tree = render();
    const labels = rail(tree).map((b) => b.props['aria-label']);
    expect(labels).not.toContain('Inventory');
    expect(labels).toContain('Settings');
    expect(railButton(tree, 'Settings').props['aria-pressed']).toBe(true);
    const picker = tree.root.findByProps({ id: 'admin-group-picker' });
    expect(picker.findAllByType('option').map((o) => o.props.value)).not.toContain('INVENTORY');
  });
});

describe('selectedAdminGroup', () => {
  const items = adminNavFor([Role.PLATFORM_ADMIN]);
  const groups = adminNavGroupsFor(items);

  it('prefers the picked section, then the current page, then the first section', () => {
    const active = activeAdminItem(items, '/dashboard/admin/finance', '');
    expect(selectedAdminGroup(groups, 'STAFF', active).id).toBe('STAFF');
    expect(selectedAdminGroup(groups, null, active).id).toBe('FINANCE');
    expect(selectedAdminGroup(groups, null, null).id).toBe(ADMIN_NAV_GROUPS[0].id);
  });

  it('ignores a pick the role cannot see, and returns null with no sections', () => {
    const hrItems = adminNavFor([Role.HR_ADMIN]);
    const hrGroups = adminNavGroupsFor(hrItems);
    expect(hrGroups.map((g) => g.id)).not.toContain('INVENTORY');
    expect(selectedAdminGroup(hrGroups, 'INVENTORY', activeAdminItem(hrItems, '/dashboard/admin/employees', '')).id).toBe('SETTINGS');
    expect(adminNavGroupsFor(adminNavFor([Role.CUSTOMER]))).toEqual(
      ADMIN_NAV_GROUPS.filter((g) => ADMIN_NAV_ITEMS.some((i) => i.group === g.id && i.status === 'planned')),
    );
    expect(selectedAdminGroup([], null, null)).toBeNull();
  });
});
