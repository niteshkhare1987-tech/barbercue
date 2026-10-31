import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { Role } from '@barbercue/shared';
import { ADMIN_NAV_GROUPS, ADMIN_NAV_ITEMS, activeAdminItem, adminNavFor, plannedItem } from '../admin-nav';
import { AdminFiltersProvider, useAdminFilters } from '../admin-filters';
import { OWNER_SHELL_PATH } from '../../../layout/HideOnOwnerShell';

const APP_DIR = path.join(__dirname, '../../../../app/(dashboard)');

describe('admin navigation', () => {
  it('every live item opens a real page, and every planned item a known planned page', () => {
    for (const item of ADMIN_NAV_ITEMS) {
      if (item.status === 'planned') {
        expect(item.href).toBe(`/dashboard/admin/planned/${item.id}`);
        expect(plannedItem(item.id)).toBe(item);
        expect(item.needs).toBeTruthy();
        continue;
      }
      const page = path.join(APP_DIR, ...item.href.split('/').filter(Boolean), 'page.tsx');
      expect({ href: item.href, exists: fs.existsSync(page) }).toEqual({ href: item.href, exists: true });
    }
    expect(fs.existsSync(path.join(APP_DIR, 'dashboard/admin/planned/[id]/page.tsx'))).toBe(true);
  });

  it('has unique ids and covers the 13 blueprint sections plus Inventory', () => {
    const ids = ADMIN_NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ADMIN_NAV_GROUPS).toHaveLength(14);
    for (const group of ADMIN_NAV_GROUPS) {
      expect(ADMIN_NAV_ITEMS.some((i) => i.group === group.id)).toBe(true);
    }
  });

  it('only lists the live pages each role may open (the API re-checks on the server)', () => {
    const live = (roles) => adminNavFor(roles).filter((i) => i.status === 'live').map((i) => i.id);
    expect(live([Role.PLATFORM_ADMIN])).toEqual(expect.arrayContaining(['executive', 'chart-builder', 'open-closed', 'admin-users']));
    expect(live([Role.PLATFORM_VIEWER])).toEqual(expect.arrayContaining(['executive', 'chart-builder', 'open-closed']));
    expect(live([Role.PLATFORM_VIEWER])).not.toContain('admin-users');
    const hr = live([Role.HR_ADMIN]);
    expect(hr).toEqual(expect.arrayContaining(['open-closed', 'employees', 'field-crm']));
    expect(hr).not.toContain('executive');
    expect(hr).not.toContain('chart-builder');
    expect(live([Role.CUSTOMER])).toEqual([]);
  });

  it('highlights the sidebar item that matches the URL, query presets included', () => {
    const items = adminNavFor([Role.PLATFORM_ADMIN]);
    expect(activeAdminItem(items, '/dashboard/admin/analytics/chart-builder', 'preset=bookings').id).toBe('booking-trends');
    expect(activeAdminItem(items, '/dashboard/admin/analytics/chart-builder', '').id).toBe('chart-builder');
    expect(activeAdminItem(items, '/dashboard/admin/shops/status', 'filter=quiet').id).toBe('quiet-shops');
    expect(activeAdminItem(items, '/dashboard/admin', '').id).toBe('all-shops');
    expect(activeAdminItem(items, '/dashboard/admin/crm/analytics', '').id).toBe('crm-analytics');
    expect(activeAdminItem(items, '/dashboard/admin/crm/leads/123', '').id).toBe('field-crm');
  });

  it('keeps admin routes out of the public site chrome without touching owner routes', () => {
    expect(OWNER_SHELL_PATH.test('/dashboard/admin')).toBe(true);
    expect(OWNER_SHELL_PATH.test('/dashboard/admin/shops/status')).toBe(true);
    expect(OWNER_SHELL_PATH.test('/dashboard/salons/abc/queue')).toBe(true);
    expect(OWNER_SHELL_PATH.test('/admin/login')).toBe(false);
    expect(OWNER_SHELL_PATH.test('/dashboard/salons')).toBe(false);
    expect(OWNER_SHELL_PATH.test('/dashboard/administrator')).toBe(false);
  });
});

describe('shared reporting period', () => {
  let api;
  function Probe() {
    api = useAdminFilters();
    return <span>{`${api.range.preset} ${api.range.from} ${api.range.to}`}</span>;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-26T20:00:00.000Z') }); // 27 Oct IST
    const store = {};
    globalThis.window = {
      sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    };
  });
  afterEach(() => {
    jest.useRealTimers();
    delete globalThis.window;
  });

  it('defaults to the last 30 IST days and survives a remount (sidebar navigation)', () => {
    let tree;
    act(() => { tree = TestRenderer.create(<AdminFiltersProvider><Probe /></AdminFiltersProvider>); });
    expect(api.range).toEqual({ preset: 'last30', from: '2026-09-28', to: '2026-10-27' });

    act(() => api.setPreset('thisMonth'));
    expect(api.range).toEqual({ preset: 'thisMonth', from: '2026-10-01', to: '2026-10-27' });

    act(() => tree.unmount());
    act(() => { tree = TestRenderer.create(<AdminFiltersProvider><Probe /></AdminFiltersProvider>); });
    expect(api.range.preset).toBe('thisMonth');
  });

  it('rejects an invalid custom range and keeps the previous one', () => {
    act(() => { TestRenderer.create(<AdminFiltersProvider><Probe /></AdminFiltersProvider>); });
    let message;
    act(() => { message = api.setCustom('2026-10-20', '2026-10-01'); });
    expect(message).toMatch(/on or after/);
    expect(api.range.preset).toBe('last30');
    act(() => { message = api.setCustom('2026-10-01', '2026-10-20'); });
    expect(message).toBeNull();
    expect(api.range).toEqual({ preset: 'custom', from: '2026-10-01', to: '2026-10-20' });
  });
});
