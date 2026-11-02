import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalPrivateStorageDriver,
  PrivateObjectStorageService,
} from './private-object-storage.service';

describe('private object storage', () => {
  const env = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fq-private-'));
  });
  afterEach(() => {
    process.env = { ...env };
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a private directory nested inside the public upload directory', () => {
    process.env.LOCAL_STORAGE_DIR = dir;
    process.env.PRIVATE_STORAGE_DIR = join(dir, 'private');
    expect(LocalPrivateStorageDriver.fromEnv()).toBeNull();
    process.env.PRIVATE_STORAGE_DIR = join(dir, '..', 'fq-private-sibling');
    expect(LocalPrivateStorageDriver.fromEnv()).not.toBeNull();
  });

  it('round-trips bytes and refuses path traversal', async () => {
    const driver = new LocalPrivateStorageDriver(dir);
    await driver.put('onboarding/a/b.jpg', Buffer.from('abc'));
    await expect(driver.get('onboarding/a/b.jpg')).resolves.toEqual(
      Buffer.from('abc'),
    );
    await expect(driver.put('../escape.jpg', Buffer.from('x'))).rejects.toThrow(
      'outside',
    );
    await driver.delete('onboarding/a/b.jpg');
    await expect(driver.get('onboarding/a/b.jpg')).resolves.toBeNull();
  });

  it('fails truthfully when nothing is configured', async () => {
    const service = PrivateObjectStorageService.withDriver(null);
    expect(service.isConfigured).toBe(false);
    await expect(
      service.put('k', Buffer.from('x'), 'image/jpeg'),
    ).rejects.toMatchObject({
      code: 'PRIVATE_STORAGE_NOT_CONFIGURED',
    });
  });
});
