// Why: every recursive host delete Orca performs (worktrees, terminal history, quarantined recovery
// generations) races whatever else is touching the tree — AV/indexers/late handle releases on
// Windows, Spotlight/`mds` or a live process writing under it on macOS and Linux — and all of them
// surface transient EBUSY/ENOTEMPTY/EPERM. One helper so no call site forgets the retries.

import { rm } from 'node:fs/promises'
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { isWslUncPath } from '../shared/wsl-paths'
import {
  isTransientRemovalError,
  transientLockRemovalOptions
} from '../shared/windows-transient-lock-removal'

const REMOVE_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000]

/** Convert a native host filesystem path to the Win32 long-path namespace. */
export function toHostFilesystemPath(targetPath: string): string {
  // POSIX paths are used by WSL callers even while the Electron process runs
  // on Windows; do not reinterpret those as drive-relative Win32 paths.
  return process.platform === 'win32' &&
    isWindowsAbsolutePathLike(targetPath) &&
    !isWslUncPath(targetPath)
    ? win32.toNamespacedPath(targetPath)
    : targetPath
}

export function toHostRemovalPath(targetPath: string): string {
  // Why: Git for Windows can fail long recursive deletes even after Orca has
  // proven the worktree target; Node's host deletion should use Win32 long paths.
  return toHostFilesystemPath(targetPath)
}

/** Recursively remove a host directory tree, retrying the transient concurrent-writer failures. */
export async function removeHostTree(targetPath: string): Promise<void> {
  const removalPath = toHostRemovalPath(targetPath)
  // Why: large trees commonly surface transient ENOTEMPTY/EPERM while Node walks and removes nested
  // directories; Node's own retries absorb that before the loop below has to.
  const rmOptions = transientLockRemovalOptions()
  let attempt = 0

  while (true) {
    try {
      await rm(removalPath, rmOptions)
      return
    } catch (error) {
      if (attempt >= REMOVE_RETRY_DELAYS_MS.length || !isTransientRemovalError(error)) {
        throw error
      }
      // Why a whole second pass and not just Node's inner retries: a writer that outlives them
      // leaves directories Node already descended into, so only a fresh walk can finish the tree.
      await delay(REMOVE_RETRY_DELAYS_MS[attempt])
      attempt += 1
    }
  }
}
