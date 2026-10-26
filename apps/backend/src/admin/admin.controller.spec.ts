import { Reflector } from '@nestjs/core';
import { Role } from '@barbercue/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AdminController } from './admin.controller';

describe('AdminController authorization', () => {
  it('requires the stored PLATFORM_ADMIN role at controller level', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, AdminController)).toEqual([
      Role.PLATFORM_ADMIN,
    ]);
  });

  it('declares the intended least-privilege route role matrices', () => {
    const reflector = new Reflector();
    const routeRoles = (methodName: string): Role[] | undefined => {
      const handler = Object.getOwnPropertyDescriptor(
        AdminController.prototype,
        methodName,
      )?.value as (...args: never[]) => unknown;

      return reflector.get<Role[]>(ROLES_KEY, handler);
    };
    expect(routeRoles('overview')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
      Role.SALES_ADMIN,
      Role.PLATFORM_VIEWER,
    ]);
    expect(routeRoles('shopActivityReport')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
      Role.SALES_ADMIN,
      Role.PLATFORM_VIEWER,
    ]);
    expect(routeRoles('executiveOverview')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
      Role.PLATFORM_VIEWER,
    ]);
    expect(routeRoles('crmOverview')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
      Role.SALES_ADMIN,
    ]);
    expect(routeRoles('crmAnalytics')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('crmLeadsPage')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('crmVisitsPage')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('crmFollowUpsPage')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('listEmployees')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
      Role.HR_ADMIN,
    ]);
    expect(routeRoles('listVerification')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
    ]);
    expect(routeRoles('deleteShop')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
    ]);
    expect(routeRoles('listAdminAccess')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('grantAdminAccess')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('revokeAdminAccess')).toEqual([Role.PLATFORM_ADMIN]);
    expect(routeRoles('updateShopStatus')).toEqual([
      Role.PLATFORM_ADMIN,
      Role.CO_FOUNDER,
    ]);
    expect(routeRoles('listLocationProposals')).toBeUndefined();
    expect(routeRoles('decideLocationProposal')).toBeUndefined();
  });

  it('masks broad monitoring PII for viewer, HR, and sales while preserving it for platform operations', async () => {
    const overview = { generatedAt: '2026-08-28T00:00:00.000Z' };
    const monitoring = { getOverview: jest.fn().mockResolvedValue(overview) };
    const verification = {
      list: jest.fn(),
      getOne: jest.fn(),
      startReview: jest.fn(),
      decide: jest.fn(),
    };
    const salonManagement = { deleteSalon: jest.fn() };
    const activation = { updateStatusAsAdmin: jest.fn() };
    const controller = new AdminController(
      monitoring as never,
      verification as never,
      salonManagement as never,
      activation as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (const [role, expectedMask] of [
      [Role.PLATFORM_VIEWER, true],
      [Role.HR_ADMIN, true],
      [Role.SALES_ADMIN, true],
      [Role.PLATFORM_ADMIN, false],
      [Role.CO_FOUNDER, false],
    ] as const) {
      monitoring.getOverview.mockClear();
      await expect(
        controller.overview({
          id: 'admin-1',
          roles: [role],
          audience: 'ADMIN',
        } as never),
      ).resolves.toBe(overview);
      expect(monitoring.getOverview).toHaveBeenCalledWith({
        maskPii: expectedMask,
      });
    }
  });

  // Phase 18 — the only mutating surface on this otherwise read-only controller: a human
  // PLATFORM_ADMIN's explicit approve/reject decision, never an automated one.
  it('delegates the verification review-queue operations', async () => {
    const monitoring = { getOverview: jest.fn() };
    const verification = {
      list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getOne: jest.fn().mockResolvedValue({ id: 'vr-1' }),
      startReview: jest
        .fn()
        .mockResolvedValue({ id: 'vr-1', status: 'UNDER_REVIEW' }),
      decide: jest.fn().mockResolvedValue({ id: 'vr-1', status: 'APPROVED' }),
    };
    const salonManagement = { deleteSalon: jest.fn() };
    const activation = { updateStatusAsAdmin: jest.fn() };
    const controller = new AdminController(
      monitoring as never,
      verification as never,
      salonManagement as never,
      activation as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.listVerification('SUBMITTED', undefined, undefined);
    expect(verification.list).toHaveBeenCalledWith(
      'SUBMITTED',
      undefined,
      undefined,
    );

    await controller.getVerification('vr-1');
    expect(verification.getOne).toHaveBeenCalledWith('vr-1');

    await controller.startReview({ id: 'admin-1' } as never, 'vr-1');
    expect(verification.startReview).toHaveBeenCalledWith('admin-1', 'vr-1');

    await controller.decide({ id: 'admin-1' } as never, 'vr-1', {
      decision: 'APPROVED',
      reviewNotes: undefined,
    } as never);
    expect(verification.decide).toHaveBeenCalledWith(
      'admin-1',
      'vr-1',
      'APPROVED',
      undefined,
    );
  });

  it('delegates shop deletion to AdminSalonManagementService', async () => {
    const monitoring = { getOverview: jest.fn() };
    const verification = {
      list: jest.fn(),
      getOne: jest.fn(),
      startReview: jest.fn(),
      decide: jest.fn(),
    };
    const salonManagement = {
      deleteSalon: jest.fn().mockResolvedValue({ deleted: true }),
    };
    const activation = { updateStatusAsAdmin: jest.fn() };
    const controller = new AdminController(
      monitoring as never,
      verification as never,
      salonManagement as never,
      activation as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await controller.deleteShop({ id: 'admin-1' } as never, 'salon-1');
    expect(salonManagement.deleteSalon).toHaveBeenCalledWith(
      'admin-1',
      'salon-1',
    );
  });

  it('delegates lifecycle status changes to the activation service', async () => {
    const monitoring = { getOverview: jest.fn() };
    const verification = {
      list: jest.fn(),
      getOne: jest.fn(),
      startReview: jest.fn(),
      decide: jest.fn(),
    };
    const salonManagement = { deleteSalon: jest.fn() };
    const activation = {
      updateStatusAsAdmin: jest
        .fn()
        .mockResolvedValue({ id: 'salon-1', status: 'ACTIVE' }),
    };
    const controller = new AdminController(
      monitoring as never,
      verification as never,
      salonManagement as never,
      activation as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.updateShopStatus({ id: 'admin-1' } as never, 'salon-1', {
        status: 'ACTIVE',
      } as never),
    ).resolves.toEqual({ id: 'salon-1', status: 'ACTIVE' });
    expect(activation.updateStatusAsAdmin).toHaveBeenCalledWith(
      'admin-1',
      'salon-1',
      { status: 'ACTIVE' },
    );
  });
});
