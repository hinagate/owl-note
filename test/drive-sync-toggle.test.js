// Re-enabling Drive sync must flush BOTH directions of the backlog that built up
// while sync was off: notes stranded device-local go up (reconcileLocalToDrive),
// and Drive files whose notes were permanently deleted come down. The delete side
// used to wait for the next app launch, because retryPendingDriveCleanup was wired
// only into initUI.
//
// These tests assert that the toggle TRIGGERS the retry. What the retry then does
// with the persisted checkpoint is drive-gc.test.js's job — asserting it again here
// would need this test to run a cleanup pass of its own to settle the floating
// promise, and that pass, not the toggle, would be what deleted the file.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as gc from '../src/lib/drive-gc.js';
import { toggleDriveSync } from '../src/app/app.js';

// Spread the real modules so every other named import in the graph still resolves.
vi.mock('../src/lib/drive-gc.js', async (importOriginal) => ({
  ...(await importOriginal()),
  retryPendingDriveCleanup: vi.fn(async () => ({ deleted: 0, pending: 0 })),
}));
vi.mock('../src/lib/drive/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureFolder: vi.fn(async () => 'folder-id'),
}));
vi.mock('../src/lib/drive/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

beforeEach(() => {
  installFakeChrome();
  gc.retryPendingDriveCleanup.mockClear();
  gc.retryPendingDriveCleanup.mockResolvedValue({ deleted: 0, pending: 0 });
  chrome.permissions = { request: async () => true, contains: async () => true };
  globalThis.confirm = () => true;
});

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('re-enabling Drive sync', () => {
  it('flushes deletions that were checkpointed while sync was off', async () => {
    expect(await toggleDriveSync(true)).toBe(true);
    await tick();

    expect(gc.retryPendingDriveCleanup).toHaveBeenCalledTimes(1);
  });

  it('stays enabled when that deferred cleanup fails', async () => {
    gc.retryPendingDriveCleanup.mockRejectedValue(new Error('offline'));

    // The ids stay checkpointed for the boot-time retry, so a failed flush must not
    // report the toggle itself as failed.
    expect(await toggleDriveSync(true)).toBe(true);
    await tick();

    expect(await chrome.storage.local.get('drive:enabled')).toEqual({ 'drive:enabled': true });
  });

  it('does not run cleanup when the user declines the consent prompt', async () => {
    globalThis.confirm = () => false;

    expect(await toggleDriveSync(true)).toBe(false);
    await tick();

    expect(gc.retryPendingDriveCleanup).not.toHaveBeenCalled();
  });

  it('does not run cleanup when sync is being turned off', async () => {
    expect(await toggleDriveSync(false)).toBe(false);
    await tick();

    expect(gc.retryPendingDriveCleanup).not.toHaveBeenCalled();
  });
});
