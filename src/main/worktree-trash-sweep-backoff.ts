// Why: a trashed checkout that a live process keeps writing under fails removal on every launch, and
// the sweep had no memory of that — measured on one machine at 267 leftover entries / 3804 inodes,
// a 265 ms warm walk (worse cold) re-issued at every cold start against trees it is guaranteed to
// fail. This records the failure so the retry is scheduled instead of immediate. It only ever delays
// a retry; nothing here abandons an entry, and the disk is still reclaimed once the writer goes.

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Deliberately not a `wt-…` name, so `isWorktreeTrashEntryName` never treats this as sweepable. */
export const TRASH_SWEEP_BACKOFF_FILE_NAME = '.orca-sweep-backoff.json'

// Consecutive-failure ladder, clamped at the last step. Launches a day apart still retry every
// entry; only a burst of relaunches stops re-walking the trees that just failed.
export const TRASH_SWEEP_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]
export const TRASH_SWEEP_MAX_RETRY_DELAY_MS = Math.max(...TRASH_SWEEP_RETRY_DELAYS_MS)

export type TrashSweepFailure = { readonly failures: number; readonly nextAttemptAt: number }
export type TrashSweepFailures = Map<string, TrashSweepFailure>

export function trashSweepBackoffPath(trashRoot: string): string {
  return join(trashRoot, TRASH_SWEEP_BACKOFF_FILE_NAME)
}

function parseFailures(parsed: unknown): TrashSweepFailures {
  const failures: TrashSweepFailures = new Map()
  if (typeof parsed !== 'object' || parsed === null) {
    return failures
  }
  for (const [entry, record] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof record !== 'object' || record === null) {
      continue
    }
    const { failures: count, nextAttemptAt } = record as Partial<TrashSweepFailure>
    if (Number.isFinite(count) && Number.isFinite(nextAttemptAt) && (count as number) > 0) {
      failures.set(entry, { failures: count as number, nextAttemptAt: nextAttemptAt as number })
    }
  }
  return failures
}

export async function readTrashSweepFailures(trashRoot: string): Promise<TrashSweepFailures> {
  const path = trashSweepBackoffPath(trashRoot)
  try {
    return parseFailures(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    // Fail open: a torn or hand-edited file must not pin the sweep, so drop it and sweep everything.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await rm(path, { force: true }).catch(() => {})
    }
    return new Map()
  }
}

export async function writeTrashSweepFailures(
  trashRoot: string,
  failures: TrashSweepFailures
): Promise<void> {
  const path = trashSweepBackoffPath(trashRoot)
  try {
    if (failures.size === 0) {
      await rm(path, { force: true })
      return
    }
    await writeFile(path, JSON.stringify(Object.fromEntries(failures)), 'utf8')
  } catch (error) {
    // Best effort: losing the record costs one extra walk on the next launch, nothing more.
    console.warn(`[worktrees] Failed to record trash sweep backoff at ${path}`, error)
  }
}

export function isTrashSweepEntryDue(record: TrashSweepFailure | undefined, now: number): boolean {
  if (!record) {
    return true
  }
  // The second clause: a clock that has since moved backwards must not park an entry indefinitely.
  return now >= record.nextAttemptAt || record.nextAttemptAt - now > TRASH_SWEEP_MAX_RETRY_DELAY_MS
}

export function nextTrashSweepFailure(
  previous: TrashSweepFailure | undefined,
  now: number
): TrashSweepFailure {
  const failures = (previous?.failures ?? 0) + 1
  const step = Math.min(failures, TRASH_SWEEP_RETRY_DELAYS_MS.length) - 1
  return { failures, nextAttemptAt: now + TRASH_SWEEP_RETRY_DELAYS_MS[step] }
}
