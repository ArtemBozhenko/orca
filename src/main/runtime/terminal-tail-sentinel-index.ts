import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './terminal-wait-detection'

/**
 * Which retained tail lines match the wait-blocked sentinel, memoized per
 * lines-array identity.
 *
 * Why: `computeTerminalTailWaitState` must prove the ABSENCE of a signal, so it
 * cannot early-exit and re-tested all 2000 retained lines on every scan (20/s
 * per streaming PTY) even though only ~20 lines were new. Keyed weakly by the
 * array so an entry dies with the tail it describes; the tail array is replaced
 * on every append and never mutated in place, so at most one entry per PTY
 * stays live.
 */
const sentinelMatchesByTailLines = new WeakMap<readonly string[], number[]>()

function collectSentinelMatches(
  lines: readonly string[],
  startIndex: number,
  into: number[]
): void {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(lines[index]!)) {
      into.push(index)
    }
  }
}

/** Ascending indices of sentinel-matching lines; full-scans an unseen array. */
export function getTerminalTailSentinelMatches(lines: readonly string[]): readonly number[] {
  const cached = sentinelMatchesByTailLines.get(lines)
  if (cached) {
    return cached
  }
  const matches: number[] = []
  collectSentinelMatches(lines, 0, matches)
  sentinelMatchesByTailLines.set(lines, matches)
  return matches
}

export function tailMayContainBlockedSignal(lines: readonly string[]): boolean {
  return getTerminalTailSentinelMatches(lines).length > 0
}

/**
 * Derive `nextLines`' match index from `previousLines`', testing only the lines
 * the append actually produced.
 *
 * The caller guarantees `nextLines[0 … carriedCount)` are the very same strings
 * as `previousLines[carriedSourceStart … carriedSourceStart + carriedCount)`,
 * and that every later line is newly produced. Matches outside that carried
 * window are dropped because their lines were evicted or rewritten, which is
 * exactly what the full scan would conclude.
 */
export function carryTerminalTailSentinelMatches(
  previousLines: readonly string[],
  nextLines: readonly string[],
  carriedSourceStart: number,
  carriedCount: number
): void {
  if (nextLines === previousLines) {
    return
  }
  const matches: number[] = []
  if (carriedCount > 0) {
    const carriedEnd = carriedSourceStart + carriedCount
    for (const index of getTerminalTailSentinelMatches(previousLines)) {
      if (index >= carriedEnd) {
        break
      }
      if (index >= carriedSourceStart) {
        matches.push(index - carriedSourceStart)
      }
    }
  }
  collectSentinelMatches(nextLines, carriedCount, matches)
  sentinelMatchesByTailLines.set(nextLines, matches)
}
