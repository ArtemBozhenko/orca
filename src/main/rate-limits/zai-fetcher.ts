import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

export const ZAI_USAGE_ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit'
export const ZAI_CN_USAGE_ENDPOINT = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'

const API_TIMEOUT_MS = 15_000
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

// Why: z.ai reports a window as {unit, number}; only these unit codes are
// documented by the responses the GLM Coding Plan returns today, and an
// unknown code is dropped rather than guessed into the wrong bucket.
const UNIT_MINUTES: Record<number, number> = {
  3: 60,
  4: 60 * 24,
  6: 60 * 24 * 7
}

type ZaiQuotaLimit = {
  unit?: unknown
  number?: unknown
  percentage?: unknown
  nextResetTime?: unknown
}

type ZaiQuotaResponse = {
  code?: unknown
  msg?: unknown
  success?: unknown
  data?: {
    level?: unknown
    limits?: ZaiQuotaLimit[]
  }
}

export type FetchZaiRateLimitsOptions = {
  apiKey: string
  endpoint?: string
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function makeResult(
  fields: Partial<ProviderRateLimits> & Pick<ProviderRateLimits, 'status'>
): ProviderRateLimits {
  return {
    provider: 'zai',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    usageMetadata: { source: 'web' },
    ...fields
  }
}

function makeUnavailable(error: string): ProviderRateLimits {
  return makeResult({
    status: 'unavailable',
    error,
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  })
}

function makeError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return makeResult({ status: 'error', error, usageMetadata: { failureKind, source: 'web' } })
}

function parseWindow(limit: ZaiQuotaLimit): { minutes: number; window: RateLimitWindow } | null {
  const unit = asNumber(limit.unit)
  const count = asNumber(limit.number)
  const percentage = asNumber(limit.percentage)
  if (unit === null || count === null || percentage === null) {
    return null
  }
  const unitMinutes = UNIT_MINUTES[unit]
  if (!unitMinutes) {
    return null
  }
  const minutes = unitMinutes * count
  const resetsAt = asNumber(limit.nextResetTime)
  return {
    minutes,
    window: {
      usedPercent: clampPercent(percentage),
      // Why: the status bar labels the two contracted buckets (5h / 7d); report
      // those exact durations so a 295-minute drift doesn't relabel the bar.
      windowMinutes:
        minutes <= WEEKLY_WINDOW_MINUTES / 2 ? SESSION_WINDOW_MINUTES : WEEKLY_WINDOW_MINUTES,
      resetsAt: resetsAt !== null && resetsAt > 0 ? resetsAt : null,
      resetDescription: null
    }
  }
}

function selectWindows(limits: ZaiQuotaLimit[]): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  let session: { minutes: number; window: RateLimitWindow } | null = null
  let weekly: { minutes: number; window: RateLimitWindow } | null = null
  for (const limit of limits) {
    const parsed = parseWindow(limit)
    if (!parsed) {
      continue
    }
    if (parsed.minutes <= WEEKLY_WINDOW_MINUTES / 2) {
      // Why: keep the tightest short window — that's the one that stops work first.
      if (!session || parsed.minutes < session.minutes) {
        session = parsed
      }
      continue
    }
    if (!weekly || parsed.minutes < weekly.minutes) {
      weekly = parsed
    }
  }
  return { session: session?.window ?? null, weekly: weekly?.window ?? null }
}

function handleHttpError(status: number): ProviderRateLimits | null {
  if (status === 401 || status === 403) {
    return makeError('Z.ai rejected the API key. Replace it in Settings.', 'stale-token')
  }
  if (status === 429) {
    return makeError('Z.ai rate-limited the usage request', 'rate-limited')
  }
  if (status >= 500) {
    return makeError(`Z.ai usage fetch failed (${status})`, 'server')
  }
  return status === 200 ? null : makeError(`Z.ai usage fetch failed (${status})`, 'unknown')
}

export async function fetchZaiRateLimits(
  options: FetchZaiRateLimitsOptions
): Promise<ProviderRateLimits> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) {
    return makeUnavailable('Z.ai API key not configured')
  }
  try {
    const response = await net.fetch(options.endpoint ?? ZAI_USAGE_ENDPOINT, {
      // Why: z.ai's monitor API takes the raw key — a `Bearer ` prefix 401s.
      headers: { Authorization: apiKey, 'Accept-Language': 'en-US,en' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    const httpError = handleHttpError(response.status)
    if (httpError) {
      return httpError
    }
    let payload: ZaiQuotaResponse
    try {
      payload = (await response.json()) as ZaiQuotaResponse
    } catch {
      return makeError('Invalid Z.ai usage response', 'parse')
    }
    if (payload.success === false) {
      const message = typeof payload.msg === 'string' ? payload.msg : 'Z.ai returned an error'
      return makeError(message, 'usage-unavailable')
    }
    const { session, weekly } = selectWindows(payload.data?.limits ?? [])
    if (!session && !weekly) {
      return makeError('Z.ai returned no usage windows', 'usage-unavailable')
    }
    return makeResult({
      status: 'ok',
      session,
      weekly,
      planType: typeof payload.data?.level === 'string' ? payload.data.level : null
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Z.ai usage error'
    return makeError(message, 'network')
  }
}
