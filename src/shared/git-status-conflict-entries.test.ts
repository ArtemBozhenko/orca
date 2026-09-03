/**
 * `u` records for asymmetric conflict kinds each cost an `fs.access`. Resolving them concurrently
 * must not move a row, change how many probes run, or change which error wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusPorcelainRecord } from './git-status-porcelain-parser'
import type { GitStatusEntry } from './git-status-types'
import type * as NodeFsPromisesModule from 'node:fs/promises'

const { accessMock } = vi.hoisted(() => ({ accessMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  access: accessMock
}))

/**
 * `parseUnmergedEntry` only rethrows when reading `error.code` itself throws, so this is how a
 * record is made to reject rather than degrade to 'modified'.
 */
function rejectionEscapingTheErrnoGuard(failure: Error): unknown {
  return new Proxy(
    {},
    {
      get: () => {
        throw failure
      }
    }
  )
}

const { parseUnmergedEntry, resolveUnmergedStatusRecords } =
  await import('./git-status-conflict-entries')

const WORKTREE = '/repo'

function unmergedLine(xy: string, filePath: string): string {
  return `u ${xy} N... 100644 100644 100644 100644 aaa bbb ccc ${filePath}`
}

function entryRecord(path: string): StatusPorcelainRecord {
  return { type: 'entry', entry: { path, status: 'modified', area: 'unstaged' } }
}

/** Mixes both conflict families: UU/AA return without I/O, AU/UA/DU/UD each probe the filesystem. */
const MIXED_RECORDS: StatusPorcelainRecord[] = [
  { type: 'unmerged', line: unmergedLine('UU', 'both-modified.ts') },
  entryRecord('plain-one.ts'),
  { type: 'unmerged', line: unmergedLine('AU', 'added-by-us.ts') },
  { type: 'unmerged', line: unmergedLine('AA', 'both-added.ts') },
  { type: 'unmerged', line: unmergedLine('UA', 'added-by-them.ts') },
  entryRecord('plain-two.ts'),
  { type: 'unmerged', line: unmergedLine('DU', 'deleted-by-us.ts') },
  { type: 'unmerged', line: unmergedLine('UD', 'deleted-by-them.ts') },
  { type: 'unmerged', line: unmergedLine('160000', 'submodule-ignored.ts') }
]

/** The pre-change consumption: one `await` per record, in Git's output order. */
async function collectSerially(
  records: readonly StatusPorcelainRecord[]
): Promise<(GitStatusEntry | null)[]> {
  const collected: (GitStatusEntry | null)[] = []
  for (const record of records) {
    collected.push(
      record.type === 'entry' ? record.entry : await parseUnmergedEntry(WORKTREE, record.line)
    )
  }
  return collected
}

async function collectConcurrently(
  records: readonly StatusPorcelainRecord[]
): Promise<(GitStatusEntry | null)[]> {
  const resolved = await resolveUnmergedStatusRecords(WORKTREE, records, records.length)
  return records.map((record, index) => {
    if (record.type === 'entry') {
      return record.entry
    }
    const settled = resolved[index]
    if (settled?.ok === false) {
      throw settled.error
    }
    return settled?.entry ?? null
  })
}

describe('resolveUnmergedStatusRecords', () => {
  beforeEach(() => {
    accessMock.mockReset()
  })

  it('produces the same rows, in the same order, as the serial read', async () => {
    accessMock.mockImplementation((target: string) =>
      target.includes('deleted-by')
        ? Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' }))
        : Promise.resolve(undefined)
    )

    const serial = await collectSerially(MIXED_RECORDS)
    const concurrent = await collectConcurrently(MIXED_RECORDS)

    expect(concurrent).toEqual(serial)
    expect(concurrent.map((entry) => entry?.path ?? null)).toEqual([
      'both-modified.ts',
      'plain-one.ts',
      'added-by-us.ts',
      'both-added.ts',
      'added-by-them.ts',
      'plain-two.ts',
      'deleted-by-us.ts',
      'deleted-by-them.ts',
      null
    ])
    expect(concurrent.map((entry) => entry?.status ?? null)).toEqual([
      'modified',
      'modified',
      'modified',
      'modified',
      'modified',
      'modified',
      'deleted',
      'deleted',
      null
    ])
  })

  it('runs the same number of filesystem probes as the serial read', async () => {
    accessMock.mockResolvedValue(undefined)
    await collectSerially(MIXED_RECORDS)
    const serialProbes = accessMock.mock.calls.length

    accessMock.mockClear()
    await collectConcurrently(MIXED_RECORDS)

    // Only the four asymmetric kinds probe; UU/AA/submodule never touch the filesystem.
    expect(serialProbes).toBe(4)
    expect(accessMock.mock.calls.length).toBe(serialProbes)
  })

  it('never exceeds the concurrency bound', async () => {
    let inFlight = 0
    let peak = 0
    accessMock.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
    })
    const records = Array.from({ length: 50 }, (_, index) => ({
      type: 'unmerged' as const,
      line: unmergedLine('AU', `conflict-${index}.ts`)
    }))

    await resolveUnmergedStatusRecords(WORKTREE, records, records.length)

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('resolves only the requested prefix, leaving later records for the caller', async () => {
    accessMock.mockResolvedValue(undefined)

    const resolved = await resolveUnmergedStatusRecords(WORKTREE, MIXED_RECORDS, 4)

    expect(resolved[0]).toEqual({
      ok: true,
      entry: expect.objectContaining({ path: 'both-modified.ts' })
    })
    expect(resolved[1]).toBeUndefined()
    expect(resolved[6]).toBeUndefined()
    expect(accessMock.mock.calls.length).toBe(1)
  })

  it('surfaces the earliest failing record, exactly as the serial read did', async () => {
    const firstFailure = new Error('first failure')
    const secondFailure = new Error('second failure')
    accessMock.mockImplementation((target: string) => {
      if (target.endsWith('added-by-them.ts')) {
        return Promise.reject(rejectionEscapingTheErrnoGuard(firstFailure))
      }
      if (target.endsWith('deleted-by-us.ts')) {
        return Promise.reject(rejectionEscapingTheErrnoGuard(secondFailure))
      }
      return Promise.resolve(undefined)
    })

    await expect(collectSerially(MIXED_RECORDS)).rejects.toBe(firstFailure)
    await expect(collectConcurrently(MIXED_RECORDS)).rejects.toBe(firstFailure)
  })

  it('does not surface a failure the serial read would never have reached', async () => {
    const lateFailure = new Error('late failure')
    accessMock.mockImplementation((target: string) =>
      target.endsWith('deleted-by-them.ts')
        ? Promise.reject(rejectionEscapingTheErrnoGuard(lateFailure))
        : Promise.resolve(undefined)
    )

    // The caller stops before that record, so the captured rejection is simply never replayed.
    const resolved = await resolveUnmergedStatusRecords(
      WORKTREE,
      MIXED_RECORDS,
      MIXED_RECORDS.length
    )
    const consumedPrefix = MIXED_RECORDS.slice(0, 7).map((record, index) =>
      record.type === 'entry' ? record.entry : resolved[index]
    )

    expect(consumedPrefix).not.toContainEqual({ ok: false, error: lateFailure })
    expect(resolved[7]).toEqual({ ok: false, error: lateFailure })
  })
})
