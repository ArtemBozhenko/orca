import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'
import { isSystemSessionEnding } from '../crash-reporting/expected-teardown-state'
import type { CreateMainWindowOptions } from './main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'

// Why 45s of *silence*: in the field a recovery reload that lands does so in 0.3-2s (slowest observed 30.4s),
// while a stalled one never lands at all — silent for up to 4h until the user force-quits. The budget measures
// time since the last observed milestone, not since issue, so a progressing load is never called stalled.
export const RENDERER_RECOVERY_LOAD_TIMEOUT_MS = 45_000
// Why: the dev load comes from Vite, whose cold start (or restart) legitimately outruns any packaged-load budget.
export const RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS = 180_000
// Why: one retry covers a one-off stalled or aborted load; a second failure is the machine, not the load.
const RENDERER_RECOVERY_LOAD_ATTEMPTS = 2
// Why a cap: milestone kicks must not defer the verdict forever on a load that inches forward and never lands.
// It holds the same ~90s worst case as before, since only a load that reached a document can be kicked at all.
const RENDERER_RECOVERY_LOAD_CAP_FACTOR = 2

/** Automatic recovery vs the prompt's manual Reload; they must not share one breadcrumb name. */
export type RecoveryReloadTrigger = 'automatic' | 'manual-retry'

/** How far a load got. Ranked, so an attempt's milestone only ever moves forward. */
export type RecoveryReloadMilestone = 'none' | 'committed' | 'dom-ready'
const MILESTONE_RANK: Record<RecoveryReloadMilestone, number> = {
  none: 0,
  committed: 1,
  'dom-ready': 2
}

export type RendererRecoveryReloadWatchdog = {
  /** Issues a recovery reload and arms the stall watchdog. */
  issue: (
    details: Electron.RenderProcessGoneDetails,
    recentRecoveryCount: number,
    trigger?: RecoveryReloadTrigger
  ) => void
  /** Settles the in-flight recovery reload as landed; safe to call for any load. */
  settleLoaded: () => void
  /** Restarts the stall budget after a suspend froze the timer mid-load. */
  notifySystemResume: () => void
  clear: () => void
}

type RecoveryReload = {
  attempt: number
  details: Electron.RenderProcessGoneDetails
  recentRecoveryCount: number
  /** Never rewritten: the elapsedMs a crash bundle reads has to stay time-since-issue. */
  issuedAt: number
  /** Absolute deadline. A suspend pushes it out; a milestone cannot. */
  capAt: number
  milestone: RecoveryReloadMilestone
  progressedSinceArm: boolean
}

type RecoveryReloadSeed = Pick<RecoveryReload, 'attempt' | 'details' | 'recentRecoveryCount'>

/**
 * Watches the automatic recovery reload for a load that never produces a document.
 *
 * The reload had no failure path at all: `loadFile`/`loadURL` rejections were discarded, no `did-fail-load`
 * listener existed, and the crash-loop breaker only counts renderer *deaths* — so a reload that silently never
 * lands never trips it and never reaches the recovery prompt. 62% of field bundles with a recovery reload end
 * exactly there: main process alive, renderer child spawned, no document, and a window the user force-quits.
 *
 * The verdict is deliberately one-sided. Nothing can cancel a pending Chromium load and nothing can dismiss a
 * native message box, so escalation keeps watching instead of forgetting: a load that lands late still records
 * the truth, and the prompt's Reload refuses to destroy a window that recovered behind the dialog.
 */
export function createRendererRecoveryReloadWatchdog(args: {
  /** True when a renderer death has already queued its own recovery, which then owns the next load. */
  isRecoveryPending: () => boolean
  isWindowClosing: () => boolean
  mainWindow: BrowserWindow
  opts?: CreateMainWindowOptions
  reloadMainWindow: (onError?: (error: Error) => void) => void
  rendererWebContentsId: number
}): RendererRecoveryReloadWatchdog {
  const {
    isRecoveryPending,
    isWindowClosing,
    mainWindow,
    opts,
    reloadMainWindow,
    rendererWebContentsId
  } = args
  // Why cached: `mainWindow.webContents` throws once the window is destroyed, and clear() runs during teardown.
  const rendererWebContents = mainWindow.webContents
  let inFlight: RecoveryReload | null = null
  // Why kept past escalation: the pending load is uncancellable, so a late did-finish-load still owns the outcome.
  let escalated: RecoveryReload | null = null
  let documentLanded = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  // Why: mirrors loadMainWindow's dev/prod branch — a Vite-served document has a different honest budget.
  const timeoutMs = (): number =>
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS
      : RENDERER_RECOVERY_LOAD_TIMEOUT_MS

  const armTimer = (reload: RecoveryReload): void => {
    clearTimer()
    reload.progressedSinceArm = false
    timer = setTimeout(
      () => onBudgetExpired(reload),
      Math.max(0, Math.min(timeoutMs(), reload.capAt - Date.now()))
    )
    timer.unref?.()
  }

  const onBudgetExpired = (reload: RecoveryReload): void => {
    if (inFlight !== reload) {
      return
    }
    // Why: a load that reached a new milestone is progressing, and 'no did-finish-load yet' is not evidence of a
    // stall — aborting it here restarts a nearly-done load cold and can miss the budget it would have made.
    if (reload.progressedSinceArm && Date.now() < reload.capAt) {
      armTimer(reload)
      return
    }
    fail(reload)
  }

  const start = (seed: RecoveryReloadSeed, trigger: RecoveryReloadTrigger): void => {
    const issuedAt = Date.now()
    const reload: RecoveryReload = {
      ...seed,
      issuedAt,
      capAt: issuedAt + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR,
      milestone: 'none',
      progressedSinceArm: false
    }
    inFlight = reload
    escalated = null
    documentLanded = false
    // Why: mark this in-place reload so the did-finish-load orphan sweep spares live PTYs until session restore (#5787).
    opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id, trigger)
    reloadMainWindow((error) => fail(reload, mainWindowLoadErrorCode(error)))
    armTimer(reload)
  }

  const retryFrom = (reload: RecoveryReload): void => {
    // Why: no API dismisses a native message box, so a load that lands while the prompt is up leaves Reload aimed
    // at a healthy window; reloading it would destroy the session the recovery just restored.
    if (documentLanded) {
      escalated = null
      return
    }
    start(
      { attempt: 1, details: reload.details, recentRecoveryCount: reload.recentRecoveryCount },
      'manual-retry'
    )
  }

  const fail = (reload: RecoveryReload, errorCode?: string): void => {
    // Why: a superseded attempt still rejects (ERR_ABORTED); only the live one owns the outcome.
    if (inFlight !== reload) {
      return
    }
    // Why before any mutation: teardown is not a verdict. Disarming here would leave a canceled close, or a
    // logoff the process outlives, with an unwatched stall and a modal raised mid-shutdown.
    if (
      isWindowClosing() ||
      opts?.getIsQuitting?.() ||
      mainWindow.isDestroyed() ||
      isSystemSessionEnding()
    ) {
      return
    }
    inFlight = null
    clearTimer()
    opts?.onRecoveryReloadOutcome?.({
      status: errorCode === undefined ? 'timeout' : 'failed',
      attempt: reload.attempt,
      // Why clamp: a backward wall-clock jump must not publish a negative duration into a crash bundle.
      elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
      progress: reload.milestone,
      ...(errorCode === undefined ? {} : { errorCode })
    })
    if (isRecoveryPending()) {
      return
    }
    // Why only a load that never reached a document: a cold retry is the remedy for a load that went nowhere,
    // and the wrong one for a document that parsed and then hung — that restart throws the work away.
    if (reload.attempt < RENDERER_RECOVERY_LOAD_ATTEMPTS && reload.milestone === 'none') {
      start({ ...reload, attempt: reload.attempt + 1 }, 'automatic')
      return
    }
    escalated = reload
    opts?.onRendererRecoveryExhausted?.({
      details: reload.details,
      webContentsId: rendererWebContentsId,
      recentRecoveryCount: reload.recentRecoveryCount,
      cause: 'reload-stalled',
      // Why: the prompt's default button is Reload, and an unwatched retry drops the user back into the same
      // silent hang with no further prompt — the retry has to be watched or the remedy is one-shot.
      retry: () => retryFrom(reload)
    })
  }

  // Why these two: they separate the field failure (renderer spawned, no document, ever) from a machine that is
  // merely slow — commit means the document arrived, dom-ready that it parsed. isLoadingMainFrame() cannot make
  // that call: it reads true for a stalled load and a progressing one alike.
  const observeMilestone = (milestone: RecoveryReloadMilestone) => (): void => {
    if (!inFlight || MILESTONE_RANK[milestone] <= MILESTONE_RANK[inFlight.milestone]) {
      return
    }
    inFlight.milestone = milestone
    inFlight.progressedSinceArm = true
  }
  const onDidNavigate = observeMilestone('committed')
  const onDomReady = observeMilestone('dom-ready')
  rendererWebContents.on('did-navigate', onDidNavigate)
  rendererWebContents.on('dom-ready', onDomReady)

  return {
    issue: (details, recentRecoveryCount, trigger = 'automatic') =>
      start({ attempt: 1, details, recentRecoveryCount }, trigger),
    settleLoaded: () => {
      documentLanded = true
      const reload = inFlight ?? escalated
      const afterPrompt = inFlight === null && escalated !== null
      inFlight = null
      escalated = null
      clearTimer()
      if (!reload) {
        return
      }
      opts?.onRecoveryReloadOutcome?.({
        status: 'loaded',
        attempt: reload.attempt,
        elapsedMs: Math.max(0, Date.now() - reload.issuedAt),
        // Why published: without it a bundle for a recovery that worked reads as exhausted, misleading triage
        // in exactly the way the paired-outcome crumb exists to prevent.
        ...(afterPrompt ? { afterPrompt: true } : {})
      })
    },
    // Why: sleep freezes the timer, so it fires on wake against a load that never got its budget — and would
    // abort a healthy load, or across both attempts raise the dialog on a healthy machine. Move the deadline
    // only; issuedAt stays put so elapsedMs remains time-since-issue rather than time-since-last-resume.
    notifySystemResume: () => {
      if (!inFlight) {
        return
      }
      inFlight.capAt = Date.now() + timeoutMs() * RENDERER_RECOVERY_LOAD_CAP_FACTOR
      armTimer(inFlight)
    },
    clear: () => {
      inFlight = null
      escalated = null
      clearTimer()
      rendererWebContents.off?.('did-navigate', onDidNavigate)
      rendererWebContents.off?.('dom-ready', onDomReady)
    }
  }
}
