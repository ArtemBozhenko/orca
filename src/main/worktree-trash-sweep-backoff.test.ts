import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { removeHostTreeMock } = vi.hoisted(() => ({
  removeHostTreeMock: vi.fn<(path: string) => Promise<void>>()
}))
vi.mock('./host-tree-removal', () => ({ removeHostTree: removeHostTreeMock }))

const { sweepStaleWorktreeTrash, WORKTREE_TRASH_DIR_NAME } = await import('./worktree-trash')
const { TRASH_SWEEP_MAX_RETRY_DELAY_MS, TRASH_SWEEP_RETRY_DELAYS_MS, trashSweepBackoffPath } =
  await import('./worktree-trash-sweep-backoff')

const ENTRY = 'wt-1700000000000-abcdef01'
const OTHER_ENTRY = 'wt-1700000000001-abcdef02'

let scratchDir = ''
let trashRoot = ''

function transientFailure(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' })
}

async function readBackoff(): Promise<Record<string, { failures: number; nextAttemptAt: number }>> {
  return JSON.parse(await readFile(trashSweepBackoffPath(trashRoot), 'utf8'))
}

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), 'orca-trash-backoff-'))
  trashRoot = join(scratchDir, WORKTREE_TRASH_DIR_NAME)
  await mkdir(join(trashRoot, ENTRY, 'node_modules'), { recursive: true })
  removeHostTreeMock.mockReset()
  removeHostTreeMock.mockRejectedValue(transientFailure())
})

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true })
})

describe('sweepStaleWorktreeTrash backoff', () => {
  it('does not re-walk a failing entry on the next launch', async () => {
    await sweepStaleWorktreeTrash([scratchDir])
    await sweepStaleWorktreeTrash([scratchDir])

    // Without the persisted record, every launch re-walks the same doomed tree forever.
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
    expect(existsSync(join(trashRoot, ENTRY))).toBe(true)
  })

  it('reports the deferral rather than counting it as swept', async () => {
    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0, deferred: 0 })
    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0, deferred: 1 })
  })

  it('persists the record before the sweep returns, so a quit mid-sweep keeps it', async () => {
    await sweepStaleWorktreeTrash([scratchDir])

    const backoff = await readBackoff()
    expect(backoff[ENTRY].failures).toBe(1)
    expect(backoff[ENTRY].nextAttemptAt).toBeGreaterThan(Date.now())
  })

  it('retries the entry once the backoff window has elapsed, and clears the record on success', async () => {
    await sweepStaleWorktreeTrash([scratchDir])
    await writeFile(
      trashSweepBackoffPath(trashRoot),
      JSON.stringify({ [ENTRY]: { failures: 1, nextAttemptAt: Date.now() - 1 } }),
      'utf8'
    )
    removeHostTreeMock.mockImplementation(async (path) => {
      await rm(path, { recursive: true, force: true })
    })

    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 1, deferred: 0 })
    expect(removeHostTreeMock).toHaveBeenCalledTimes(2)
    expect(existsSync(join(trashRoot, ENTRY))).toBe(false)
    // An empty ledger is deleted rather than left as a permanent file in the trash root.
    expect(existsSync(trashSweepBackoffPath(trashRoot))).toBe(false)
  })

  it('escalates the delay with each consecutive failure', async () => {
    for (const [index, delayMs] of TRASH_SWEEP_RETRY_DELAYS_MS.entries()) {
      await writeFile(
        trashSweepBackoffPath(trashRoot),
        JSON.stringify({ [ENTRY]: { failures: index, nextAttemptAt: Date.now() - 1 } }),
        'utf8'
      )
      const before = Date.now()
      await sweepStaleWorktreeTrash([scratchDir])

      const backoff = await readBackoff()
      expect(backoff[ENTRY].failures).toBe(index + 1)
      expect(backoff[ENTRY].nextAttemptAt).toBeGreaterThanOrEqual(before + delayMs)
    }
  })

  it('clamps at the last ladder step rather than deferring an entry forever', async () => {
    await writeFile(
      trashSweepBackoffPath(trashRoot),
      JSON.stringify({ [ENTRY]: { failures: 99, nextAttemptAt: Date.now() - 1 } }),
      'utf8'
    )
    const before = Date.now()
    await sweepStaleWorktreeTrash([scratchDir])
    const after = Date.now()

    const { nextAttemptAt } = (await readBackoff())[ENTRY]
    expect(nextAttemptAt).toBeGreaterThanOrEqual(before + TRASH_SWEEP_MAX_RETRY_DELAY_MS)
    expect(nextAttemptAt).toBeLessThanOrEqual(after + TRASH_SWEEP_MAX_RETRY_DELAY_MS)
  })

  it('retries an entry parked by a clock that has since moved backwards', async () => {
    await writeFile(
      trashSweepBackoffPath(trashRoot),
      JSON.stringify({
        [ENTRY]: { failures: 1, nextAttemptAt: Date.now() + TRASH_SWEEP_MAX_RETRY_DELAY_MS * 10 }
      }),
      'utf8'
    )

    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0, deferred: 0 })
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
  })

  it('drops a torn ledger and sweeps everything, exactly as before it existed', async () => {
    await writeFile(
      trashSweepBackoffPath(trashRoot),
      '{"wt-1700000000000-abcdef01": {"fail',
      'utf8'
    )

    expect(await sweepStaleWorktreeTrash([scratchDir])).toEqual({ removed: 0, deferred: 0 })
    expect(removeHostTreeMock).toHaveBeenCalledTimes(1)
    expect((await readBackoff())[ENTRY].failures).toBe(1)
  })

  it('prunes records for entries that are no longer on disk', async () => {
    await writeFile(
      trashSweepBackoffPath(trashRoot),
      JSON.stringify({ [OTHER_ENTRY]: { failures: 4, nextAttemptAt: Date.now() + 60_000 } }),
      'utf8'
    )

    await sweepStaleWorktreeTrash([scratchDir])

    expect(Object.keys(await readBackoff())).toEqual([ENTRY])
  })

  it('never offers the removal a path outside a trash root', async () => {
    const liveWorktree = join(scratchDir, 'feature')
    await mkdir(join(liveWorktree, 'src'), { recursive: true })
    await mkdir(join(trashRoot, OTHER_ENTRY), { recursive: true })
    await mkdir(join(trashRoot, 'unrelated-directory'), { recursive: true })
    await writeFile(join(trashRoot, 'wt-notes.txt'), 'keep me\n')

    await sweepStaleWorktreeTrash([scratchDir])

    const attempted = removeHostTreeMock.mock.calls.map((call) => call[0])
    expect(new Set(attempted)).toEqual(
      new Set([join(trashRoot, ENTRY), join(trashRoot, OTHER_ENTRY)])
    )
    for (const path of attempted) {
      expect(dirname(path).endsWith(`${sep}${WORKTREE_TRASH_DIR_NAME}`)).toBe(true)
    }
    expect(existsSync(liveWorktree)).toBe(true)
    expect(existsSync(join(trashRoot, 'unrelated-directory'))).toBe(true)
    expect(existsSync(join(trashRoot, 'wt-notes.txt'))).toBe(true)
  })
})
