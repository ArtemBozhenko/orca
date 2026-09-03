/**
 * `pty.inspectProcess` is the costliest polled shape in the codebase (a round trip per pane per
 * tick plus a host-side foreground scan). These are call counters, not timings: overlapping probes
 * of one pane+incarnation must collapse to one relay request, and nothing else may share.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSshPtyProviderRpcOperations } from './ssh-pty-provider-rpc-operations'

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

function createRpcOperations(): {
  operations: ReturnType<typeof createSshPtyProviderRpcOperations>
  request: ReturnType<typeof vi.fn>
  deferreds: Deferred[]
} {
  const deferreds: Deferred[] = []
  const request = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        deferreds.push({ resolve, reject })
      })
  )
  const operations = createSshPtyProviderRpcOperations({
    mux: { request } as never,
    toRelayPtyId: (id: string) => `relay-${id}`
  })
  return { operations, request, deferreds }
}

const INSPECTION = { foregroundProcess: 'claude', hasChildProcesses: true }

/** Lets every queued microtask (the dedupe wrapper included) reach the mux. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('SSH pty.inspectProcess in-flight dedupe', () => {
  it('collapses concurrent probes of one pane+incarnation into one relay request', async () => {
    const { operations, request, deferreds } = createRpcOperations()

    const probes = Array.from({ length: 8 }, () =>
      operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    )
    await flush()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('pty.inspectProcess', {
      id: 'relay-pty-1',
      expectedIncarnationId: 'inc-1'
    })

    deferreds[0].resolve(INSPECTION)
    expect(await Promise.all(probes)).toEqual(Array.from({ length: 8 }, () => INSPECTION))
  })

  it('does not share across panes, incarnations, or connections', async () => {
    const { operations, request } = createRpcOperations()

    void operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    void operations.inspectProcess('pty-2', { expectedIncarnationId: 'inc-1' })
    void operations.inspectProcess('pty-3', { expectedIncarnationId: 'inc-1' })
    // A superseded incarnation gets its own `incarnation_mismatch` answer, so it cannot join.
    void operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-2' })
    void operations.inspectProcess('pty-1')
    await flush()

    expect(request).toHaveBeenCalledTimes(5)

    const other = createRpcOperations()
    void other.operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    await flush()

    expect(other.request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('re-asks the host once the shared probe settles instead of caching the answer', async () => {
    const { operations, request, deferreds } = createRpcOperations()

    const first = operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    await flush()
    deferreds[0].resolve(INSPECTION)
    await first

    void operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
  })

  it('shares a rejection with the joiners it coalesced and re-probes on the next poll', async () => {
    const { operations, request, deferreds } = createRpcOperations()

    const probes = [
      operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' }),
      operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    ]
    await flush()
    expect(request).toHaveBeenCalledTimes(1)

    // A blip stays a rejection for every joiner: callers classify it as `unverifiable`,
    // and no verdict is synthesized inside the dedupe layer.
    const blip = Object.assign(new Error('connection lost'), { code: 'CONNECTION_LOST' })
    deferreds[0].reject(blip)
    await expect(probes[0]).rejects.toBe(blip)
    await expect(probes[1]).rejects.toBe(blip)

    void operations.inspectProcess('pty-1', { expectedIncarnationId: 'inc-1' })
    await flush()

    expect(request).toHaveBeenCalledTimes(2)
  })
})
