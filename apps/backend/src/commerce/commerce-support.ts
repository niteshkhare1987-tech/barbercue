import { createHash } from 'crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import {
  Role,
  type AuthenticatedUser,
  type CommerceFlag,
  type CommercePermission,
} from '@barbercue/shared';
import { AppException } from '../common/exceptions/app.exception';
import { PrismaService } from '../prisma/prisma.service';

export const FASTQUE_SELLER_CODE = 'FASTQUE';

export type Tx = Prisma.TransactionClient;
export type Db = Tx | PrismaService;

export const fail = (
  code: string,
  message: string,
  status: HttpStatus = HttpStatus.BAD_REQUEST,
) => new AppException(code, message, status);
export const conflict = (code: string, message: string) =>
  fail(code, message, HttpStatus.CONFLICT);
export const notFound = (what: string) =>
  fail('COMMERCE_NOT_FOUND', `${what} was not found.`, HttpStatus.NOT_FOUND);

export const sha256 = (v: string) =>
  createHash('sha256').update(v).digest('hex');
export const money = (v: Prisma.Decimal | null | undefined): string =>
  (v ?? new Prisma.Decimal(0)).toFixed(2);
export const dateOnly = (v: string) => new Date(`${v}T00:00:00.000Z`);
/** Today's date in India as a DATE value; stock expiring today or earlier is not sellable. */
export const indiaToday = (now = new Date()) =>
  dateOnly(new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10));
export const normalizePhone = (v: string) => {
  const digits = v.replace(/\D/g, '');
  return digits.length === 10
    ? `+91${digits}`
    : digits.length === 12 && digits.startsWith('91')
      ? `+${digits}`
      : digits.length === 11 && digits.startsWith('0')
        ? `+91${digits.slice(1)}`
        : `+${digits}`;
};

/** Every flag is off unless it is exactly "true"; the first one gates all the others. */
export function flag(name: CommerceFlag): boolean {
  if (process.env.FASTQUE_DIRECT_COMMERCE_ENABLED !== 'true') return false;
  return process.env[name] === 'true';
}

export const TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 15000,
  maxWait: 10000,
};

/** Every commerce route answers 404 until FASTQUE_DIRECT_COMMERCE_ENABLED=true. */
@Injectable()
export class CommerceEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!flag('FASTQUE_DIRECT_COMMERCE_ENABLED'))
      throw fail('COMMERCE_DISABLED', 'Not available.', HttpStatus.NOT_FOUND);
    return true;
  }
}

const PERMISSION = 'commercePermission';
export const CommercePermit = (permission: CommercePermission) =>
  SetMetadata(PERMISSION, permission);

/** Only these roles can ever reach the admin API; everyone else needs no grant lookup to be refused. */
export const COMMERCE_STAFF_ROLES: Role[] = [
  Role.PLATFORM_ADMIN,
  Role.CO_FOUNDER,
  Role.PLATFORM_VIEWER,
  Role.HR_ADMIN,
  Role.SALES_ADMIN,
];

/**
 * Platform admins may do everything. Other internal admins need an explicit grant per permission
 * (commerce_staff_grants), which a platform admin gives in FastQue Commerce → Settings.
 */
@Injectable()
export class CommercePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const needed = this.reflector.getAllAndOverride<
      CommercePermission | undefined
    >(PERMISSION, [context.getHandler(), context.getClass()]);
    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user || !needed)
      throw fail('FORBIDDEN', 'Not allowed.', HttpStatus.FORBIDDEN);
    const granted = await permissionsOf(this.prisma, user);
    if (!granted.includes(needed))
      throw fail(
        'COMMERCE_FORBIDDEN',
        'Your account does not have this FastQue Commerce permission.',
        HttpStatus.FORBIDDEN,
      );
    return true;
  }
}

const ALL: CommercePermission[] = [
  'view',
  'catalog',
  'warehouse',
  'procurement',
  'orders',
  'delivery',
  'finance',
  'support',
  'settings',
];
export async function permissionsOf(
  db: Db,
  user: AuthenticatedUser,
): Promise<CommercePermission[]> {
  if (user.roles.includes(Role.PLATFORM_ADMIN)) return ALL;
  if (!user.roles.some((r) => COMMERCE_STAFF_ROLES.includes(r))) return [];
  const rows = await db.commerceStaffGrant.findMany({
    where: { userId: user.id },
    select: { permission: true },
  });
  // "settings" (which includes granting permissions) is never delegated.
  return ALL.filter(
    (p) => p !== 'settings' && rows.some((r) => r.permission === p),
  );
}

/** Spreadsheet-safe CSV: quotes everything and neutralises formula prefixes. */
type CsvCell = string | number | boolean | Date | null | undefined;
export function toCsv(rows: Array<Record<string, CsvCell>>): string {
  if (!rows.length) return '';
  const cell = (v: CsvCell) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    return `"${(/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const head = Object.keys(rows[0]);
  return [
    head.map(cell).join(','),
    ...rows.map((r) => head.map((h) => cell(r[h])).join(',')),
  ].join('\r\n');
}
