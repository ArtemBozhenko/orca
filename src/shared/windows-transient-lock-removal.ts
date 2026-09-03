// Why: a recursive removal races whatever else is touching the tree. Windows is the acute case —
// antivirus, the search indexer, a just-exited child and a freshly dlopen'd DLL all keep a tree Node
// has just emptied locked for a few milliseconds — but it is not the only one: on macOS and Linux
// Spotlight/`mds`, a scanner, or a live process writing under the tree surface the same
// EBUSY/ENOTEMPTY/EPERM while Node walks it. Node's own `maxRetries` absorbs exactly that, and the
// repo settled on 8 attempts. The constant names keep the prefix the repo already ratchets on.

import type { RmOptions } from 'node:fs'
import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

export const WINDOWS_RM_MAX_RETRIES = 8
export const WINDOWS_RM_RETRY_DELAY_MS = 150

/** `rm`/`rmSync` options for a recursive removal that must survive a concurrent writer. */
export function transientLockRemovalOptions(): RmOptions {
  // Why every platform: `maxRetries` only ever re-issues the syscall that failed, against the path
  // the caller already chose. It cannot reach a path the one-shot removal would not have touched.
  return {
    recursive: true,
    force: true,
    maxRetries: WINDOWS_RM_MAX_RETRIES,
    retryDelay: WINDOWS_RM_RETRY_DELAY_MS
  }
}

/** Whether a removal failure is a concurrent writer worth re-attempting rather than a real fault. */
export function isTransientRemovalError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code && ['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code)) {
    return true
  }
  // Why Windows-only: there the failure can arrive with no `code` at all. POSIX always sets one, so
  // matching prose there would only retry unrelated errors that happen to read like a lock.
  if (process.platform !== 'win32') {
    return false
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  return /directory not empty|resource busy|operation not permitted/i.test(message)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Recursively remove a directory, retrying a transient concurrent-writer failure. */
export function removeTreeSync(targetPath: string): void {
  const options = transientLockRemovalOptions()
  let attempt = 0
  for (;;) {
    try {
      rmSync(targetPath, options)
      return
    } catch (error) {
      // Why the outer loop: Node's `maxRetries` only runs inside a real `rmSync`. A mock, or a
      // handle that outlives those inner attempts, still surfaces EPERM. `force: true` only
      // suppresses ENOENT.
      if (attempt >= WINDOWS_RM_MAX_RETRIES || !isTransientRemovalError(error)) {
        throw error
      }
      sleepSync(WINDOWS_RM_RETRY_DELAY_MS)
      attempt += 1
    }
  }
}

/** Recursively remove a directory, retrying a transient concurrent-writer failure. */
export async function removeTree(targetPath: string): Promise<void> {
  await rm(targetPath, transientLockRemovalOptions())
}
