/**
 * Returns whether an ambient deferred connect must leave a deliberately slept
 * workspace cold instead of creating a new PTY.
 */
export function shouldStayColdForDeliberateSleep(args: {
  /** A queued startup is an explicit request to launch this pane. */
  hasQueuedStartup: boolean
  /** Visible panes are expected to have a live terminal surface. */
  isPaneVisible: boolean
  /** Cleared by explicit activation or an explicit background wake. */
  hasSleepIntent: boolean
  activeWorktreeId: string | null
  worktreeId: string
}): boolean {
  if (args.hasQueuedStartup || args.isPaneVisible || !args.hasSleepIntent) {
    return false
  }
  return args.activeWorktreeId !== args.worktreeId
}
