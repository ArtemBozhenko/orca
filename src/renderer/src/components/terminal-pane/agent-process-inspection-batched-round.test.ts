// Regression guard for the inspection round-trip budget. The cadence tiers
// (active 750ms / idle 2000 / hidden 3000 / no-evidence 15000) were a per-pane
// promise the queue could not keep: the budget of 8 host round trips per second
// was spent one pane at a time, so N due panes meant roughly N/8 seconds between
// inspections for each of them and agent-completion latency degraded as the user
// added panes. Local reads now coalesce, so one round trip carries a whole round
// and per-pane latency stops scaling with pane count. The budget itself is
// unchanged — it just buys the whole round instead of one pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueAgentProcessInspection,
  resetAgentProcessInspectionQueueForTests
} from './agent-process-inspection-queue'
import {
  inspectLocalTerminalProcessCoalesced,
  resetLocalTerminalInspectionBatchForTests
} from '@/runtime/local-terminal-inspection-batch'
import {
  classifyTerminalProcessInspectionFailure,
  clientOnlyUnverifiableInspection,
  type TerminalProcessInspectionBatchEntry
} from '../../../../shared/terminal-process-inspection'

type InspectionRequest = { id: string; expectedIncarnationId?: string }

type PtyApiMock = {
  inspectProcess: ReturnType<typeof vi.fn>
  inspectProcessBatch?: ReturnType<typeof vi.fn>
}

let ptyApi: PtyApiMock
const originalWindow = (globalThis as { window?: unknown }).window

function batchMock(
  resolve: (request: InspectionRequest) => TerminalProcessInspectionBatchEntry
): ReturnType<typeof vi.fn> {
  return vi.fn(async (requests: readonly InspectionRequest[]) => requests.map(resolve))
}

function liveInspection(processName: string): TerminalProcessInspectionBatchEntry {
  return { inspection: { foregroundProcess: processName, hasChildProcesses: true } }
}

beforeEach(() => {
  ptyApi = { inspectProcess: vi.fn() }
  ;(globalThis as unknown as { window: unknown }).window = { api: { pty: ptyApi } }
})

afterEach(() => {
  vi.useRealTimers()
  resetAgentProcessInspectionQueueForTests()
  resetLocalTerminalInspectionBatchForTests()
  ;(globalThis as { window?: unknown }).window = originalWindow
})

describe('batched agent process inspection', () => {
  it('inspects every pane of a 300-pane round inside the same round-trip budget', async () => {
    vi.useFakeTimers()
    const batch = batchMock((request) => liveInspection(request.id))
    ptyApi.inspectProcessBatch = batch
    const inspected: string[] = []

    for (let index = 0; index < 300; index += 1) {
      const ptyId = `pty-${index}`
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        batched: true,
        run: async () => {
          const result = await inspectLocalTerminalProcessCoalesced(ptyId)
          inspected.push(result.foregroundProcess ?? '')
        }
      })
    }
    // Well inside one 1s rate-limiter window: pre-fix only the 8 round trips that
    // window allows are spent, so only 8 of the 300 panes are ever inspected.
    await vi.advanceTimersByTimeAsync(200)

    expect(new Set(inspected).size).toBe(300)
    expect(batch.mock.calls.length).toBeLessThanOrEqual(8)
    expect(ptyApi.inspectProcess).not.toHaveBeenCalled()
  })

  it('carries each pane its own incarnation guard and answer', async () => {
    const batch = batchMock((request) =>
      request.expectedIncarnationId === 'inc-stale'
        ? { inspection: clientOnlyUnverifiableInspection('terminal_gone') }
        : liveInspection(`agent-${request.id}`)
    )
    ptyApi.inspectProcessBatch = batch

    const [stale, live, unguarded] = await Promise.all([
      inspectLocalTerminalProcessCoalesced('pty-stale', { expectedIncarnationId: 'inc-stale' }),
      inspectLocalTerminalProcessCoalesced('pty-live', { expectedIncarnationId: 'inc-live' }),
      inspectLocalTerminalProcessCoalesced('pty-plain')
    ])

    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0]![0]).toEqual([
      { id: 'pty-stale', expectedIncarnationId: 'inc-stale' },
      { id: 'pty-live', expectedIncarnationId: 'inc-live' },
      { id: 'pty-plain' }
    ])
    expect(stale).toMatchObject({ verdict: 'unverifiable', foregroundProcess: null })
    expect(live).toMatchObject({ foregroundProcess: 'agent-pty-live' })
    expect(unguarded).toMatchObject({ foregroundProcess: 'agent-pty-plain' })
  })

  it('fails one unresolvable pane without changing any sibling verdict', async () => {
    ptyApi.inspectProcessBatch = batchMock((request) =>
      request.id === 'pty-lost' ? { error: 'connection lost' } : liveInspection('claude')
    )

    const settled = await Promise.allSettled([
      inspectLocalTerminalProcessCoalesced('pty-a'),
      inspectLocalTerminalProcessCoalesced('pty-lost'),
      inspectLocalTerminalProcessCoalesced('pty-b')
    ])

    expect(settled[0]).toMatchObject({ status: 'fulfilled' })
    expect(settled[2]).toMatchObject({ status: 'fulfilled' })
    expect(settled[1]!.status).toBe('rejected')
    // Classified exactly as a single-pane rejection would be: unverifiable, never exited.
    expect(
      classifyTerminalProcessInspectionFailure((settled[1] as PromiseRejectedResult).reason)
    ).toBe('transport_loss')
  })

  it('reads a reply short of its request as unverifiable rather than a process verdict', async () => {
    ptyApi.inspectProcessBatch = vi.fn(async () => [])

    const results = await Promise.all([
      inspectLocalTerminalProcessCoalesced('pty-a'),
      inspectLocalTerminalProcessCoalesced('pty-b')
    ])

    for (const result of results) {
      expect(result).toMatchObject({ verdict: 'unverifiable', foregroundProcess: null })
    }
  })

  it('falls back to the per-pane path when the host cannot batch', async () => {
    ptyApi.inspectProcess = vi.fn(async (id: string) => ({
      foregroundProcess: `agent-${id}`,
      hasChildProcesses: true
    }))

    const results = await Promise.all([
      inspectLocalTerminalProcessCoalesced('pty-a'),
      inspectLocalTerminalProcessCoalesced('pty-b', { expectedIncarnationId: 'inc-1' })
    ])

    expect(ptyApi.inspectProcess.mock.calls).toEqual([
      ['pty-a'],
      ['pty-b', { expectedIncarnationId: 'inc-1' }]
    ])
    expect(results[0]).toMatchObject({ foregroundProcess: 'agent-pty-a' })
    expect(results[1]).toMatchObject({ foregroundProcess: 'agent-pty-b' })
  })

  it('keeps a remote pane admitted one round trip at a time', async () => {
    vi.useFakeTimers()
    const started: string[] = []

    for (let index = 0; index < 20; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        batched: false,
        run: async () => {
          started.push(`ssh-${index}`)
        }
      })
    }
    await vi.advanceTimersByTimeAsync(200)

    expect(started.length).toBeLessThanOrEqual(8)
  })
})
