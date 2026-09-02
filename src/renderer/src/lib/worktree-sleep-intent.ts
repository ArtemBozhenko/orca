// A slept workspace keeps panes mounted while its PTYs are released. This marker
// distinguishes that deliberate cold state from an uninitialized terminal.
const sleepingWorktreeIds = new Set<string>()

export function markWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.add(worktreeId)
}

export function clearWorktreeSleepIntent(worktreeId: string): void {
  sleepingWorktreeIds.delete(worktreeId)
}

export function hasWorktreeSleepIntent(worktreeId: string | null): boolean {
  return worktreeId !== null && sleepingWorktreeIds.has(worktreeId)
}
