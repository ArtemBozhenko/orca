import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { WslShellProcessAnchor } from '../../shared/wsl-shell-process-anchor'
import type {
  WslGuestProcessInventory,
  WslGuestProcessRow
} from './wsl-guest-process-inventory-parser'

export type WslGuestProcessAnchor = WslShellProcessAnchor

export type WslGuestForegroundResolution =
  | { status: 'live'; processName: string | null; anchor: WslGuestProcessAnchor }
  | { status: 'unverifiable'; reason: string }

function normalizeTty(tty: string): string {
  return tty.startsWith('/dev/') ? tty : tty === '?' ? '' : `/dev/${tty}`
}

/** Correlate one shell anchor to its foreground group and strict agent recognizer. */
export function resolveWslGuestForegroundProcess(
  inventory: WslGuestProcessInventory,
  anchor: WslGuestProcessAnchor
): WslGuestForegroundResolution {
  if (inventory.distro.toLowerCase() !== anchor.distro.toLowerCase()) {
    return { status: 'unverifiable', reason: 'distro_mismatch' }
  }
  if (inventory.bootId !== anchor.bootId) {
    return { status: 'unverifiable', reason: 'boot_id_mismatch' }
  }
  const shell = inventory.rows.find((row) => row.pid === anchor.shellPid)
  if (!shell) {
    return { status: 'unverifiable', reason: 'anchor_missing' }
  }
  const tty = normalizeTty(shell.tty)
  if (!tty || (anchor.tty !== undefined && normalizeTty(anchor.tty) !== tty)) {
    return { status: 'unverifiable', reason: 'tty_mismatch' }
  }
  if (shell.startTimeTicks !== anchor.shellStartTime) {
    return { status: 'unverifiable', reason: 'pid_reused' }
  }
  if (shell.tpgid <= 0) {
    return { status: 'unverifiable', reason: 'foreground_group_missing' }
  }
  const group = inventory.rows.filter(
    (row) => row.pgid === shell.tpgid && normalizeTty(row.tty) === tty
  )
  if (group.length === 0) {
    return { status: 'unverifiable', reason: 'foreground_group_missing' }
  }
  // Multiplexers move the real command to another PTY/session. Without a
  // session-aware anchor, the outer shell cannot make a truthful claim.
  const isMultiplexer = (command: string): boolean =>
    /(?:^|\s)(?:tmux|screen)(?:\s|$)/.test(command)
  if (group.some((row) => isMultiplexer(row.command))) {
    return { status: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  const byPid = new Map(inventory.rows.map((row) => [row.pid, row]))
  const isShellDescendant = (row: WslGuestProcessRow): boolean => {
    const seen = new Set<number>()
    let current: WslGuestProcessRow | undefined = row
    while (current && !seen.has(current.pid)) {
      if (current.pid === shell.pid) {
        return true
      }
      seen.add(current.pid)
      current = byPid.get(current.ppid)
    }
    return false
  }
  if (
    inventory.rows.some(
      (row) =>
        row.pid !== shell.pid &&
        normalizeTty(row.tty) !== tty &&
        isMultiplexer(row.command) &&
        isShellDescendant(row)
    )
  ) {
    return { status: 'unverifiable', reason: 'multiplexer_boundary' }
  }
  const recognized = group
    .map((row) => recognizeAgentProcessFromCommandLine(row.command)?.processName ?? null)
    .filter((name): name is string => name !== null)
  if (new Set(recognized).size > 1) {
    return { status: 'unverifiable', reason: 'ambiguous_foreground_group' }
  }
  const nextAnchor = {
    ...anchor,
    bootId: inventory.bootId,
    shellStartTime: shell.startTimeTicks,
    tty
  }
  return { status: 'live', processName: recognized[0] ?? null, anchor: nextAnchor }
}
