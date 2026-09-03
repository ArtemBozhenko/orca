import { containsTerminalVerticalLineControl } from './terminal-ansi-normalization'
import { carryTerminalTailSentinelMatches } from './terminal-tail-sentinel-index'
import {
  applyTerminalLineControls,
  processTerminalTailCompleteSegments,
  splitRetainedTerminalTailSegments,
  trimTerminalLineRight
} from './terminal-tail-line-controls'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES, MAX_TAIL_PARTIAL_CHARS } from './terminal-tail-limits'
import {
  appendNormalizedToMultilineTailBufferUnwindowed,
  type RetainedTailRedrawCursor
} from './terminal-tail-redraw-buffer'

type RetainedTailLineStats = {
  totalChars: number
  /** Whether every line is already right-trimmed, so the redraw prefix trim is a no-op. */
  rightTrimmed: boolean
}

// Why weak + array-keyed: the tail is replaced (never mutated) on every append, so an entry dies
// with the array it describes and only the live tail per PTY is retained. Carrying the char total
// this way replaces a full-tail re-sum on every chunk.
const tailLineStatsByLines = new WeakMap<readonly string[], RetainedTailLineStats>()

function getRetainedTailLineStats(lines: readonly string[]): RetainedTailLineStats {
  const cached = tailLineStatsByLines.get(lines)
  if (cached) {
    return cached
  }
  let totalChars = 0
  let rightTrimmed = true
  for (const line of lines) {
    totalChars += line.length
    if (rightTrimmed && trimTerminalLineRight(line) !== line) {
      rightTrimmed = false
    }
  }
  const stats = { totalChars, rightTrimmed }
  tailLineStatsByLines.set(lines, stats)
  return stats
}

export function appendNormalizedToTailBuffer(
  previousLines: string[],
  previousPartialLine: string,
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null = null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  if (normalizedChunk.length === 0) {
    return {
      lines: previousLines,
      partialLine: previousPartialLine,
      redrawCursor: previousRedrawCursor,
      truncated: false,
      newCompleteLines: 0,
      newlyCompletedLines: []
    }
  }

  // Why: fullscreen TUIs emit long newline-free redraw streams; keep the line transcript for pagination but bound partial-line work.
  const previousPartialWasCapped = previousPartialLine.length > MAX_TAIL_PARTIAL_CHARS
  const boundedPreviousPartialLine = previousPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const combinedChunk = `${boundedPreviousPartialLine}${normalizedChunk}`
  if (previousRedrawCursor || containsTerminalVerticalLineControl(combinedChunk)) {
    return appendNormalizedToMultilineTailBuffer(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
  }

  // Why: status UIs redraw one line via CR/backspace/erase; retain the latest redraw segment instead of appending every spinner frame.
  const segments = splitRetainedTerminalTailSegments(combinedChunk)
  const pieces = processTerminalTailCompleteSegments(segments.completeSegments)
  const newlyCompletedLines: string[] = []
  let newlyCompletedChars = 0
  for (const piece of pieces) {
    const line = trimTerminalLineRight(piece)
    newlyCompletedLines.push(line)
    newlyCompletedChars += line.length
  }
  const partialResult = applyTerminalLineControls(segments.partialSegment)
  const nextPartialLine = trimTerminalLineRight(partialResult.text)
  const retainedPartialLine = nextPartialLine.slice(-MAX_TAIL_PARTIAL_CHARS)
  const newCompleteLines = segments.completeLineCount
  const omittedNewCompleteLines = newCompleteLines - pieces.length
  let nextLines =
    newCompleteLines > 0
      ? [...(omittedNewCompleteLines > 0 ? [] : previousLines), ...newlyCompletedLines]
      : previousLines
  let truncated =
    previousPartialWasCapped ||
    omittedNewCompleteLines > 0 ||
    nextPartialLine.length > MAX_TAIL_PARTIAL_CHARS

  // The plain path only ever appends, so the whole previous tail carries unless it was discarded.
  const carriesPreviousLines = newCompleteLines === 0 || omittedNewCompleteLines === 0
  const previousStats = carriesPreviousLines ? getRetainedTailLineStats(previousLines) : null
  let carriedSourceStart = 0
  let carriedCount = carriesPreviousLines ? previousLines.length : 0
  let nextLinesChars =
    (previousStats?.totalChars ?? 0) + (newCompleteLines > 0 ? newlyCompletedChars : 0)

  if (nextLines.length > MAX_TAIL_LINES) {
    const evictedCount = nextLines.length - MAX_TAIL_LINES
    for (let index = 0; index < evictedCount; index += 1) {
      nextLinesChars -= nextLines[index]!.length
    }
    nextLines = nextLines.slice(evictedCount)
    truncated = true
    const carriedShift = Math.min(evictedCount, carriedCount)
    carriedSourceStart += carriedShift
    carriedCount -= carriedShift
  }

  if (newCompleteLines > 0 || retainedPartialLine.length > previousPartialLine.length) {
    let totalChars = nextLinesChars + retainedPartialLine.length
    let trimStartIndex = 0
    while (trimStartIndex < nextLines.length && totalChars > MAX_TAIL_CHARS) {
      totalChars -= nextLines[trimStartIndex]!.length
      trimStartIndex += 1
    }
    if (trimStartIndex > 0) {
      nextLinesChars = totalChars - retainedPartialLine.length
      nextLines = nextLines.slice(trimStartIndex)
      truncated = true
      const carriedShift = Math.min(trimStartIndex, carriedCount)
      carriedSourceStart += carriedShift
      carriedCount -= carriedShift
    }
  }

  if (nextLines !== previousLines) {
    tailLineStatsByLines.set(nextLines, {
      totalChars: nextLinesChars,
      rightTrimmed: carriedCount === 0 || (previousStats?.rightTrimmed ?? true)
    })
    carryTerminalTailSentinelMatches(previousLines, nextLines, carriedSourceStart, carriedCount)
  }

  const redrawCursor =
    !partialResult.hadControl || partialResult.cursorColumn === nextPartialLine.length
      ? null
      : {
          rowFromEnd: 0,
          column: partialResult.cursorColumn
        }

  return {
    lines: nextLines,
    partialLine: retainedPartialLine,
    redrawCursor,
    truncated,
    newCompleteLines,
    newlyCompletedLines
  }
}

// Why a window: the unwindowed impl below is O(tail) per chunk (~93% of the event loop under TUI flood, findings log 2026-07-03); a redraw only touches rows the cursor reaches, so window the suffix and share the prefix by reference. Equivalence fuzz-verified in retained-tail-redraw-window.equivalence.test.ts.
const REDRAW_WINDOW_SAFETY_ROWS = 8

// Why module-level: this ran `new RegExp` per redraw chunk — i.e. per TUI frame per PTY.
// Safe to share because `maxUpwardCursorReach` is synchronous and non-reentrant; it resets
// `lastIndex` before every scan.
const CURSOR_UP_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(\\d*)(?:;[\\d;]*)?A`, 'g')

function maxUpwardCursorReach(
  normalizedChunk: string,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): number {
  let reach = previousRedrawCursor ? previousRedrawCursor.rowFromEnd : 0
  CURSOR_UP_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CURSOR_UP_PATTERN.exec(normalizedChunk)) !== null) {
    reach += match[1] ? Number.parseInt(match[1], 10) : 1
  }
  return reach
}

function appendNormalizedToMultilineTailBuffer(
  previousLines: string[],
  boundedPreviousPartialLine: string,
  normalizedChunk: string,
  previousPartialWasCapped: boolean,
  previousRedrawCursor: RetainedTailRedrawCursor | null
): {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  truncated: boolean
  newCompleteLines: number
  newlyCompletedLines: string[]
} {
  const windowRows =
    maxUpwardCursorReach(normalizedChunk, previousRedrawCursor) + REDRAW_WINDOW_SAFETY_ROWS
  if (windowRows >= previousLines.length) {
    const unwindowed = appendNormalizedToMultilineTailBufferUnwindowed(
      previousLines,
      boundedPreviousPartialLine,
      normalizedChunk,
      previousPartialWasCapped,
      previousRedrawCursor
    )
    if (unwindowed.lines !== previousLines) {
      let totalChars = 0
      for (const line of unwindowed.lines) {
        totalChars += line.length
      }
      // Why nothing carries: an unwindowed redraw may rewrite any retained row.
      tailLineStatsByLines.set(unwindowed.lines, { totalChars, rightTrimmed: true })
      carryTerminalTailSentinelMatches(previousLines, unwindowed.lines, 0, 0)
    }
    return unwindowed
  }
  const prefixLength = previousLines.length - windowRows
  const suffix = previousLines.slice(prefixLength)
  const windowed = appendNormalizedToMultilineTailBufferUnwindowed(
    suffix,
    boundedPreviousPartialLine,
    normalizedChunk,
    previousPartialWasCapped,
    previousRedrawCursor
  )
  const previousStats = getRetainedTailLineStats(previousLines)
  let lines = previousLines.slice(0, prefixLength)
  let linesChars = previousStats.totalChars
  for (const line of suffix) {
    linesChars -= line.length
  }
  let carriedSourceStart = 0
  let carriedCount = prefixLength
  if (!previousStats.rightTrimmed) {
    // Why: the shared prefix must match the unwindowed finalize's trailing-space trim without paying a regex per untouched row.
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      const lastChar = line.charCodeAt(line.length - 1)
      if (lastChar === 32 || lastChar === 9) {
        const trimmed = line.replace(/[ \t]+$/g, '')
        lines[index] = trimmed
        linesChars -= line.length - trimmed.length
        carriedCount = 0
      }
    }
  }
  for (const line of windowed.lines) {
    lines.push(line)
    linesChars += line.length
  }
  let truncated = windowed.truncated
  if (lines.length > MAX_TAIL_LINES) {
    const evictedCount = lines.length - MAX_TAIL_LINES
    for (let index = 0; index < evictedCount; index += 1) {
      linesChars -= lines[index]!.length
    }
    lines = lines.slice(evictedCount)
    truncated = true
    const carriedShift = Math.min(evictedCount, carriedCount)
    carriedSourceStart += carriedShift
    carriedCount -= carriedShift
  }
  let totalChars = linesChars + windowed.partialLine.length
  let dropCount = 0
  while (dropCount < lines.length && totalChars > MAX_TAIL_CHARS) {
    totalChars -= lines[dropCount]!.length
    dropCount += 1
  }
  if (dropCount > 0) {
    linesChars = totalChars - windowed.partialLine.length
    lines = lines.slice(dropCount)
    truncated = true
    const carriedShift = Math.min(dropCount, carriedCount)
    carriedSourceStart += carriedShift
    carriedCount -= carriedShift
  }
  tailLineStatsByLines.set(lines, { totalChars: linesChars, rightTrimmed: true })
  carryTerminalTailSentinelMatches(previousLines, lines, carriedSourceStart, carriedCount)
  return {
    lines,
    partialLine: windowed.partialLine,
    redrawCursor: windowed.redrawCursor,
    truncated,
    newCompleteLines: windowed.newCompleteLines,
    newlyCompletedLines: windowed.newlyCompletedLines
  }
}
