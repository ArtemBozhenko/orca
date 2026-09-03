import { describe, expect, it, vi } from 'vitest'
import { appendNormalizedToTailBuffer } from './terminal-tail-buffer'
import { MAX_TAIL_CHARS, MAX_TAIL_LINES } from './terminal-tail-limits'
import { buildPreview } from './terminal-tail-state'
import { tailMayContainBlockedSignal } from './terminal-tail-sentinel-index'
import { computeTerminalTailWaitState } from './terminal-wait-tail-state'
import { TERMINAL_WAIT_BLOCKED_SENTINEL_RE } from './terminal-wait-detection'
import type { RetainedTailRedrawCursor } from './terminal-tail-redraw-buffer'

// The definition the incremental index must reproduce: does ANY retained line (or the
// partial line) match the sentinel? Written out independently of the implementation.
function referenceMayContainBlockedSignal(lines: string[], partialLine: string): boolean {
  for (const line of lines) {
    if (TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(line)) {
      return true
    }
  }
  return TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)
}

function indexedMayContainBlockedSignal(lines: string[], partialLine: string): boolean {
  return tailMayContainBlockedSignal(lines) || TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(partialLine)
}

type TailSim = {
  lines: string[]
  partialLine: string
  redrawCursor: RetainedTailRedrawCursor | null
  preview: string
}

function newSim(): TailSim {
  return { lines: [], partialLine: '', redrawCursor: null, preview: '' }
}

function feed(sim: TailSim, chunk: string): void {
  const next = appendNormalizedToTailBuffer(sim.lines, sim.partialLine, chunk, sim.redrawCursor)
  sim.lines = next.lines
  sim.partialLine = next.partialLine
  sim.redrawCursor = next.redrawCursor
  sim.preview = buildPreview(next.lines, next.partialLine)
}

/** A structurally identical tail the index has never seen, so it takes the full-scan path. */
function unindexed(sim: TailSim): string[] {
  return [...sim.lines]
}

function assertMatchesFullScan(sim: TailSim): void {
  expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(
    referenceMayContainBlockedSignal(sim.lines, sim.partialLine)
  )
  expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)).toEqual(
    computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
  )
}

const BLOCKED_LINE = 'Update available! Press Enter to continue.'

function countSentinelTests(run: () => void): number {
  const spy = vi.spyOn(TERMINAL_WAIT_BLOCKED_SENTINEL_RE, 'test')
  try {
    run()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

function saturatedSim(): TailSim {
  const sim = newSim()
  for (let index = 0; index < MAX_TAIL_LINES + 400; index += 1) {
    feed(sim, `streaming build output line ${index}\n`)
  }
  expect(sim.lines.length).toBe(MAX_TAIL_LINES)
  return sim
}

describe('terminal tail sentinel index', () => {
  it('tests only the lines an append produced, not the whole retained tail', () => {
    const sim = saturatedSim()
    // Warm the index for the current tail identity.
    computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)

    const incrementalTests = countSentinelTests(() => {
      for (let index = 0; index < 20; index += 1) {
        feed(sim, `fresh line ${index}\n`)
      }
      computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)
    })

    const fullScanTests = countSentinelTests(() => {
      computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
    })

    expect(fullScanTests).toBeGreaterThanOrEqual(MAX_TAIL_LINES)
    // 20 appended lines + one partial-line test per compute call.
    expect(incrementalTests).toBeLessThanOrEqual(25)
  })

  it('keeps a retained sentinel visible and drops it exactly when it is evicted', () => {
    const sim = saturatedSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)

    // Push the prompt to the very last retained slot.
    for (let index = 0; index < MAX_TAIL_LINES - 1; index += 1) {
      feed(sim, `after prompt ${index}\n`)
      expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    }
    expect(sim.lines[0]).toBe(BLOCKED_LINE)

    // One more line evicts it.
    feed(sim, 'evicting line\n')
    expect(sim.lines.includes(BLOCKED_LINE)).toBe(false)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)

    // And it stays gone many chunks later.
    for (let index = 0; index < 200; index += 1) {
      feed(sim, `long after eviction ${index}\n`)
    }
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)
  })

  it('drops a sentinel evicted by the retained-character cap', () => {
    const sim = newSim()
    feed(sim, `${BLOCKED_LINE}\n`)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    const bulkLine = `${'x'.repeat(4000)}\n`
    for (let index = 0; index * 4001 < MAX_TAIL_CHARS + 20000; index += 1) {
      feed(sim, bulkLine)
    }
    expect(sim.lines.includes(BLOCKED_LINE)).toBe(false)
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)
  })

  it('finds a sentinel split across two chunks once the line completes', () => {
    const sim = saturatedSim()
    feed(sim, 'Codex asks: press ent')
    // Still only a partial line, and no alternative matches the fragment yet.
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(false)
    assertMatchesFullScan(sim)

    feed(sim, 'er to confirm')
    // Now complete, but still the partial line — the partial is always tested directly.
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)

    feed(sim, '\n')
    // And once it becomes a retained line the index carries it.
    expect(sim.partialLine).toBe('')
    expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(true)
    assertMatchesFullScan(sim)
  })

  it('full-scans a tail array the index has never seen (seed/restore path)', () => {
    // primeWaitBlockedBaselineFromSeededTail reads whatever tail the restore seed installed.
    const seeded = ['boot log', BLOCKED_LINE, 'trailing']
    expect(tailMayContainBlockedSignal(seeded)).toBe(true)
    const state = computeTerminalTailWaitState(seeded, '', '')
    expect(state.fromTail).toBe(true)
    expect(state.signal?.reason).toBe('codex-update-prompt')

    const clean = ['boot log', 'no prompt here', 'trailing']
    expect(tailMayContainBlockedSignal(clean)).toBe(false)
    expect(computeTerminalTailWaitState(clean, '', '').signal).toBeNull()
  })

  it('reports fromTail from a blank tail without consulting the index', () => {
    const sim = newSim()
    feed(sim, '   \n\t\n')
    expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, '').fromTail).toBe(false)
    feed(sim, 'now visible\n')
    expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, '').fromTail).toBe(true)
  })
})

// Deterministic PRNG so a divergence is reproducible from the seed alone.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ESC = String.fromCharCode(27)

/**
 * `streaming` saturates and evicts the retained tail; `tui` trades saturation for redraw
 * coverage (cursor-up rewrites of retained rows, and reaches past the redraw window).
 */
function randomChunk(random: () => number, profile: 'streaming' | 'tui'): string {
  const roll = random()
  if (roll < 0.2) {
    const lines: string[] = []
    for (let index = 0; index < 30; index += 1) {
      lines.push(`burst line ${Math.floor(random() * 1e6)}`)
    }
    return `${lines.join('\n')}\n`
  }
  if (roll < 0.42) {
    return `plain output ${Math.floor(random() * 1e6)}\n`
  }
  if (roll < 0.48) {
    return `${'   '.repeat(Math.floor(random() * 3))}\n`
  }
  if (roll < 0.54) {
    return `${BLOCKED_LINE}\n`
  }
  if (roll < 0.58) {
    return 'do you trust the files in this folder?\n'
  }
  if (roll < 0.63) {
    // Sentinel split across a chunk boundary.
    return random() < 0.5 ? 'Codex asks: press ent' : 'er to confirm\n'
  }
  if (roll < 0.7) {
    // TUI redraw: move the cursor up a few rows and rewrite them.
    const rows = 1 + Math.floor(random() * 12)
    return `${ESC}[${rows}A${ESC}[2Kredrawn row ${Math.floor(random() * 1000)}\n`
  }
  if (roll < (profile === 'tui' ? 0.76 : 0.7)) {
    // Deep redraw that outruns the window and forces the unwindowed path.
    return `${ESC}[${1500 + Math.floor(random() * 800)}A${ESC}[2Kdeep redraw\n`
  }
  if (roll < 0.82) {
    return `\rspinner ${Math.floor(random() * 100)}%`
  }
  if (roll < 0.87) {
    return 'trailing spaces here   \n'
  }
  if (roll < 0.91) {
    return `${'y'.repeat(3000)}\n`
  }
  if (roll < 0.95) {
    return `multi\nline\nchunk ${Math.floor(random() * 1000)}\n`
  }
  if (roll < 0.97) {
    return ''
  }
  return `no newline ${Math.floor(random() * 1000)}`
}

describe('terminal tail sentinel index property', () => {
  for (const profile of ['streaming', 'tui'] as const) {
    for (const seed of [1, 7, 42, 1337]) {
      it(`matches a full scan on every step of a random ${profile} sequence (seed ${seed})`, () => {
        const random = mulberry32(seed)
        const sim = newSim()
        let sawSentinel = false
        let sawSaturation = false
        for (let step = 0; step < 1200; step += 1) {
          feed(sim, randomChunk(random, profile))
          const expected = referenceMayContainBlockedSignal(sim.lines, sim.partialLine)
          expect(indexedMayContainBlockedSignal(sim.lines, sim.partialLine)).toBe(expected)
          expect(computeTerminalTailWaitState(sim.lines, sim.partialLine, sim.preview)).toEqual(
            computeTerminalTailWaitState(unindexed(sim), sim.partialLine, sim.preview)
          )
          sawSentinel = sawSentinel || expected
          sawSaturation = sawSaturation || sim.lines.length >= MAX_TAIL_LINES
        }
        // Guard against a vacuous pass.
        expect(sawSentinel).toBe(true)
        if (profile === 'streaming') {
          expect(sawSaturation).toBe(true)
        }
      })
    }
  }
})
