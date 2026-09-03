import type * as NodeFsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { rmMock, delayMock } = vi.hoisted(() => ({
  rmMock: vi.fn<(path: string, options?: unknown) => Promise<void>>(),
  delayMock: vi.fn(async (_ms?: number) => undefined)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return { ...actual, rm: rmMock }
})
// Keep the retry ladder's real delays out of the test clock; only the attempt count is asserted.
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }))

const { removeHostTree } = await import('./host-tree-removal')
const { WINDOWS_RM_MAX_RETRIES } = await import('../shared/windows-transient-lock-removal')

/** POSIX-shaped so `toHostRemovalPath` is the identity on every platform under test. */
const TRASH_ROOT = '/workspaces/.orca-worktree-trash'
const TRASH_ENTRY = `${TRASH_ROOT}/wt-1700000000000-abcdef01`

function transientError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: transient`), { code })
}

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

const originalPlatform = process.platform

afterEach(() => {
  withPlatform(originalPlatform)
  rmMock.mockReset()
  delayMock.mockClear()
})

describe('removeHostTree', () => {
  // Why every platform: a concurrent writer (Spotlight/`mds`, a scanner, a live process under the
  // tree) is not a Windows-only hazard, and a one-shot removal on POSIX never converged.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`retries a transient ENOTEMPTY until it succeeds on ${platform}`, async () => {
      withPlatform(platform)
      rmMock.mockRejectedValueOnce(transientError('ENOTEMPTY'))
      rmMock.mockRejectedValueOnce(transientError('ENOTEMPTY'))
      rmMock.mockResolvedValueOnce(undefined)

      await expect(removeHostTree(TRASH_ENTRY)).resolves.toBeUndefined()

      expect(rmMock).toHaveBeenCalledTimes(3)
      // The retry may only change how many times the SAME path is attempted.
      expect(new Set(rmMock.mock.calls.map((call) => call[0]))).toEqual(new Set([TRASH_ENTRY]))
      expect(rmMock.mock.calls[0]?.[1]).toEqual({
        recursive: true,
        force: true,
        maxRetries: WINDOWS_RM_MAX_RETRIES,
        retryDelay: expect.any(Number)
      })
    })

    it(`gives up on a non-transient failure without retrying on ${platform}`, async () => {
      withPlatform(platform)
      rmMock.mockRejectedValue(transientError('EIO'))

      await expect(removeHostTree(TRASH_ENTRY)).rejects.toThrow('EIO')
      expect(rmMock).toHaveBeenCalledTimes(1)
    })

    it(`stops after a bounded number of attempts on ${platform}`, async () => {
      withPlatform(platform)
      rmMock.mockRejectedValue(transientError('EBUSY'))

      await expect(removeHostTree(TRASH_ENTRY)).rejects.toThrow('EBUSY')
      expect(rmMock).toHaveBeenCalledTimes(5)
      expect(new Set(rmMock.mock.calls.map((call) => call[0]))).toEqual(new Set([TRASH_ENTRY]))
    })
  }

  it('does not retry prose-only failures off Windows, where every error carries a code', async () => {
    withPlatform('linux')
    rmMock.mockRejectedValue(new Error('directory not empty'))

    await expect(removeHostTree(TRASH_ENTRY)).rejects.toThrow('directory not empty')
    expect(rmMock).toHaveBeenCalledTimes(1)
  })

  it('still retries a codeless Windows failure by its message', async () => {
    withPlatform('win32')
    rmMock.mockRejectedValueOnce(new Error('directory not empty'))
    rmMock.mockResolvedValueOnce(undefined)

    await expect(removeHostTree(TRASH_ENTRY)).resolves.toBeUndefined()
    expect(rmMock).toHaveBeenCalledTimes(2)
  })
})
