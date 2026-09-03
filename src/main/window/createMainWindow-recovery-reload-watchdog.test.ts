import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableCrashBreadcrumbModule from '../crash-reporting/durable-crash-breadcrumb'

const { recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordDurableCrashBreadcrumbMock: vi.fn()
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', async (importOriginal) => ({
  ...(await importOriginal<typeof DurableCrashBreadcrumbModule>()),
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import {
  browserWindowMock,
  isMock,
  powerMonitorOnMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'
import {
  RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS,
  RENDERER_RECOVERY_LOAD_TIMEOUT_MS
} from './renderer-recovery-reload-watchdog'

const DOCUMENT_URL = 'file:///opt/orca/renderer/index.html'
// A real macOS install URL: the crash-report redactor's PATH_PATTERNS provably leave this one intact.
const INSTALL_PATH_LOAD_ERROR =
  "ERR_FILE_NOT_FOUND (-6) loading 'file:///Users/jane.doe/Applications/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'"
const CRASH = { reason: 'crashed', exitCode: 5 } as Electron.RenderProcessGoneDetails

/**
 * Regression cover for the field failure: the recovery reload is issued, never produces a document, and nothing
 * notices — no did-fail-load, no breaker (it counts renderer deaths only), no retry, no prompt.
 */
describe('renderer recovery reload watchdog', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    recordDurableCrashBreadcrumbMock.mockClear()
    vi.useFakeTimers()
  })

  const createHarness = () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    // Loads stay pending unless a test settles one: that is exactly the stall being reproduced.
    const settleLoad: { resolve: () => void; reject: (error: Error) => void }[] = []
    const pendingLoad = (): Promise<void> =>
      new Promise<void>((resolve, reject) => settleLoad.push({ resolve, reject }))
    const webContents = {
      id: 143,
      getURL: vi.fn(() => DOCUMENT_URL),
      isDestroyed: vi.fn(() => false),
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(pendingLoad),
      loadURL: vi.fn(pendingLoad)
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const crashRenderer = (): void => {
      windowHandlers['render-process-gone']?.({} as never, CRASH)
      vi.advanceTimersByTime(250)
    }
    return { browserWindowInstance, consoleError, crashRenderer, settleLoad, windowHandlers }
  }

  it('retries once when the recovery reload never produces a document, then hands the user the prompt', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    // 1 initial load + 1 recovery reload, which now stalls forever.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'timeout',
      attempt: 1,
      elapsedMs: RENDERER_RECOVERY_LOAD_TIMEOUT_MS,
      documentScheme: 'file'
    })
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS)
    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 2 })
    )
    // Retry budget spent: stop reloading and surface the only retry/quit surface the user has.
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith({
      details: CRASH,
      webContentsId: 143,
      recentRecoveryCount: 1,
      cause: 'reload-stalled',
      retry: expect.any(Function)
    })

    consoleError.mockRestore()
  })

  it('clears the watchdog when the recovery reload finishes loading', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(2_000)
    windowHandlers['did-finish-load']?.()

    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith({
      status: 'loaded',
      attempt: 1,
      elapsedMs: 2_000
    })

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 3)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('escalates a rejected recovery load immediately instead of waiting out the watchdog', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    settleLoad[1]?.reject(new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///opt/orca'"))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        attempt: 1,
        errorCode: 'ERR_FILE_NOT_FOUND'
      })
    )
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    consoleError.mockRestore()
  })

  it('ignores a superseded load rejection so ERR_ABORTED never escalates', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    // A second renderer death supersedes the first reload; Chromium rejects the abandoned load with ERR_ABORTED.
    crashRenderer()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
    settleLoad[1]?.reject(new Error('ERR_ABORTED (-3)'))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    consoleError.mockRestore()
  })

  it('gives the dev server a longer budget than a packaged load', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()
    isMock.dev = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')

    try {
      createMainWindow(null, { onRecoveryReloadOutcome })
      crashRenderer()
      expect(browserWindowInstance.loadURL).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(RENDERER_RECOVERY_DEV_LOAD_TIMEOUT_MS - 1)
      expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'timeout', attempt: 1 })
      )
    } finally {
      vi.unstubAllEnvs()
      consoleError.mockRestore()
    }
  })

  it('stays silent when the stalled window is already closing', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer, windowHandlers } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    windowHandlers.close?.({ preventDefault: vi.fn() } as never)
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)

    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(onRendererRecoveryExhausted).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })
  it('keeps the install path out of the outcome breadcrumb', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    settleLoad[1]?.reject(new Error(INSTALL_PATH_LOAD_ERROR))
    await vi.advanceTimersByTimeAsync(0)

    const outcome = onRecoveryReloadOutcome.mock.calls[0]?.[0]
    expect(outcome).toEqual({
      status: 'failed',
      attempt: 1,
      elapsedMs: 0,
      documentScheme: 'file',
      errorCode: 'ERR_FILE_NOT_FOUND'
    })
    // sanitizeCrashReportString cannot redact a file:///Users/... URL, so nothing path-shaped may reach the crumb.
    expect(JSON.stringify(outcome)).not.toContain('/')

    consoleError.mockRestore()
  })

  it('records a durable breadcrumb for a rejected load, since console output never reaches the bundle', async () => {
    const { consoleError, settleLoad } = createHarness()

    createMainWindow(null, {})
    settleLoad[0]?.reject(new Error(INSTALL_PATH_LOAD_ERROR))
    await vi.advanceTimersByTimeAsync(0)

    // Catching the rejection retired the main_unhandled_rejection crumb this used to produce.
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('main_window_load_failed', {
      errorCode: 'ERR_FILE_NOT_FOUND'
    })

    consoleError.mockRestore()
  })

  it('escalates to the prompt when both attempts are rejected outright', async () => {
    const onRecoveryReloadOutcome = vi.fn()
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer, settleLoad } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome, onRendererRecoveryExhausted })
    crashRenderer()
    settleLoad[1]?.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await vi.advanceTimersByTimeAsync(0)
    settleLoad[2]?.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    await vi.advanceTimersByTimeAsync(0)

    expect(onRecoveryReloadOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', attempt: 2, errorCode: 'ERR_CONNECTION_REFUSED' })
    )
    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'reload-stalled', recentRecoveryCount: 1 })
    )

    consoleError.mockRestore()
  })

  it('hands the prompt a watched retry so a stalled manual reload re-raises it', () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    crashRenderer()
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)

    // Reload is the dialog's default button; unwatched it returned the user to the same unbounded silent hang.
    onRendererRecoveryExhausted.mock.calls[0]?.[0].retry()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(4)

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS * 2)
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(5)
    expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(2)

    consoleError.mockRestore()
  })

  it('names the crash-loop cause and gives that prompt a watched retry too', () => {
    const onRendererRecoveryExhausted = vi.fn()
    const { consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRendererRecoveryExhausted })
    for (let attempt = 0; attempt < 4; attempt += 1) {
      crashRenderer()
    }

    expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'crash-loop' })
    )
    expect(typeof onRendererRecoveryExhausted.mock.calls[0]?.[0].retry).toBe('function')

    consoleError.mockRestore()
  })

  it('restarts the stall budget when the machine resumes mid-load', () => {
    const onRecoveryReloadOutcome = vi.fn()
    const { browserWindowInstance, consoleError, crashRenderer } = createHarness()

    createMainWindow(null, { onRecoveryReloadOutcome })
    crashRenderer()
    // Sleep freezes the timer; on wake it would otherwise fire against a load that never got its budget.
    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    const resume = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1] as (
      ...args: unknown[]
    ) => void
    resume()

    vi.advanceTimersByTime(RENDERER_RECOVERY_LOAD_TIMEOUT_MS - 1)
    expect(onRecoveryReloadOutcome).not.toHaveBeenCalled()
    expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    expect(onRecoveryReloadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'timeout', attempt: 1 })
    )

    consoleError.mockRestore()
  })
})
