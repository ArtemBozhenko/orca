import {
  clientOnlyUnverifiableInspection,
  TERMINAL_PROCESS_INSPECTION_BATCH_LIMIT,
  type TerminalProcessInspection
} from '../../../shared/terminal-process-inspection'

type PendingInspection = {
  request: { id: string; expectedIncarnationId?: string }
  resolve: (value: TerminalProcessInspection) => void
  reject: (error: unknown) => void
}

let pendingInspections: PendingInspection[] = []
let flushScheduled = false

/**
 * Coalesce the local `pty:inspectProcess` reads a single cadence round issues into one
 * IPC round trip, so per-pane inspection latency stops scaling with pane count.
 *
 * Same-tick only — a microtask, never a timer — so no pane waits on a batching window
 * its own cadence did not already contain. Each entry keeps its own
 * `expectedIncarnationId` and its own settlement: main runs the identical per-pane
 * inspection for it, and one unresolvable pane can never answer for a sibling.
 */
export function inspectLocalTerminalProcessCoalesced(
  ptyId: string,
  options?: { expectedIncarnationId?: string }
): Promise<TerminalProcessInspection> {
  if (typeof window.api.pty.inspectProcessBatch !== 'function') {
    return options?.expectedIncarnationId
      ? window.api.pty.inspectProcess(ptyId, options)
      : window.api.pty.inspectProcess(ptyId)
  }
  return new Promise<TerminalProcessInspection>((resolve, reject) => {
    pendingInspections.push({
      request: {
        id: ptyId,
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {})
      },
      resolve,
      reject
    })
    if (flushScheduled) {
      return
    }
    flushScheduled = true
    queueMicrotask(flushPendingInspections)
  })
}

function flushPendingInspections(): void {
  flushScheduled = false
  const entries = pendingInspections
  pendingInspections = []
  for (let start = 0; start < entries.length; start += TERMINAL_PROCESS_INSPECTION_BATCH_LIMIT) {
    void dispatchInspectionBatch(
      entries.slice(start, start + TERMINAL_PROCESS_INSPECTION_BATCH_LIMIT)
    )
  }
}

async function dispatchInspectionBatch(entries: PendingInspection[]): Promise<void> {
  const inspectProcessBatch = window.api.pty.inspectProcessBatch
  if (typeof inspectProcessBatch !== 'function') {
    for (const entry of entries) {
      entry.resolve(clientOnlyUnverifiableInspection('transport_loss'))
    }
    return
  }
  try {
    const results = await inspectProcessBatch(entries.map((entry) => entry.request))
    entries.forEach((entry, index) => {
      const result = Array.isArray(results) ? results[index] : undefined
      if (!result) {
        // A reply short of its request is a lost observation, never a process verdict.
        entry.resolve(clientOnlyUnverifiableInspection('transport_loss'))
        return
      }
      if (result.error !== undefined) {
        // Re-raise for this entry alone, so it classifies exactly as a single-pane rejection.
        entry.reject(new Error(result.error))
        return
      }
      entry.resolve(result.inspection)
    })
  } catch (error) {
    for (const entry of entries) {
      entry.reject(error)
    }
  }
}

export function resetLocalTerminalInspectionBatchForTests(): void {
  pendingInspections = []
  flushScheduled = false
}
