import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'
import type { CreateMainWindowOptions } from './main-window-contracts'
import { mainWindowLoadErrorCode } from './main-window-load-error-code'

// Why 45s: in the field a recovery reload that lands does so in 0.3-2s (slowest observed 30.4s), while a stalled
// one never lands at all — silent for up to 4h until the user force-quits. 45s clears the observed tail so a
// slow-but-healthy machine is never interrupted, and still bounds the dead window to ~90s across both attempts.
export const RENDERER_RECOVERY_LOAD_TIMEOUT_MS = 45_000
// Why: the dev load comes from Vite, whose cold start (or restart) legitimately outruns any packaged-load budget.
export const RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS = 180_000
// Why: one retry covers a one-off stalled or aborted load; a second failure is the machine, not the load.
const RENDERER_RECOVERY_LOAD_ATTEMPTS = 2

export type RendererRecoveryReloadWatchdog = {
  /** Issues a recovery reload and arms the stall watchdog. */
  issue: (details: Electron.RenderProcessGoneDetails, recentRecoveryCount: number) => void
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
  startedAt: number
}

/**
 * Watches the automatic recovery reload for a load that never produces a document.
 *
 * The reload had no failure path at all: `loadFile`/`loadURL` rejections were discarded, no `did-fail-load`
 * listener existed, and the crash-loop breaker only counts renderer *deaths* — so a reload that silently never
 * lands never trips it and never reaches the recovery prompt. 62% of field bundles with a recovery reload end
 * exactly there: main process alive, renderer child spawned, no document, and a window the user force-quits.
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
  let inFlight: RecoveryReload | null = null
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
  // Why scheme only: the full URL is the install path, and the crash-report redactor provably leaves a
  // `file:///Users/...` or `file:///home/...` URL intact. Blank-vs-document is the whole triage signal anyway.
  const documentScheme = (): string => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed?.() === true) {
      return 'none'
    }
    return (
      /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(mainWindow.webContents.getURL())?.[1]?.toLowerCase() ??
      'none'
    )
  }
  const armTimer = (reload: RecoveryReload): void => {
    clearTimer()
    timer = setTimeout(() => fail(reload), timeoutMs())
    timer.unref?.()
  }

  const start = (reload: RecoveryReload): void => {
    inFlight = reload
    // Why: mark this in-place reload so the did-finish-load orphan sweep spares live PTYs until session restore (#5787).
    opts?.onBeforeRecoveryReload?.(mainWindow.webContents.id)
    reloadMainWindow((error) => fail(reload, mainWindowLoadErrorCode(error)))
    armTimer(reload)
  }

  const retryFrom = (reload: RecoveryReload): void =>
    start({ ...reload, attempt: 1, startedAt: Date.now() })

  const fail = (reload: RecoveryReload, errorCode?: string): void => {
    // Why: a superseded attempt still rejects (ERR_ABORTED); only the live one owns the outcome.
    if (inFlight !== reload) {
      return
    }
    inFlight = null
    clearTimer()
    if (isWindowClosing() || opts?.getIsQuitting?.() || mainWindow.isDestroyed()) {
      return
    }
    opts?.onRecoveryReloadOutcome?.({
      status: errorCode === undefined ? 'timeout' : 'failed',
      attempt: reload.attempt,
      // Why clamp: a backward wall-clock jump must not publish a negative duration into a crash bundle.
      elapsedMs: Math.max(0, Date.now() - reload.startedAt),
      documentScheme: documentScheme(),
      ...(errorCode === undefined ? {} : { errorCode })
    })
    if (isRecoveryPending()) {
      return
    }
    if (reload.attempt < RENDERER_RECOVERY_LOAD_ATTEMPTS) {
      start({ ...reload, attempt: reload.attempt + 1, startedAt: Date.now() })
      return
    }
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

  return {
    issue: (details, recentRecoveryCount) =>
      start({ attempt: 1, details, recentRecoveryCount, startedAt: Date.now() }),
    settleLoaded: () => {
      const reload = inFlight
      inFlight = null
      clearTimer()
      if (!reload) {
        return
      }
      opts?.onRecoveryReloadOutcome?.({
        status: 'loaded',
        attempt: reload.attempt,
        elapsedMs: Math.max(0, Date.now() - reload.startedAt)
      })
    },
    // Why: sleep freezes the timer, so it fires on wake against a load that never got its budget — and would
    // abort a healthy load, or across both attempts raise the dialog on a healthy machine. Restart the budget.
    notifySystemResume: () => {
      if (!inFlight) {
        return
      }
      inFlight.startedAt = Date.now()
      armTimer(inFlight)
    },
    clear: () => {
      inFlight = null
      clearTimer()
    }
  }
}
