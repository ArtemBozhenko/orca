/**
 * Electron rejects a failed load with `ERR_* (-n) loading '<url>'`.
 *
 * That URL is the install path, and `sanitizeCrashReportString`'s PATH_PATTERNS cannot match a `file:///Users/...`
 * or `file:///home/...` URL (every interior `/` is preceded by a character inside its lookbehind), so the message
 * would reach a durable breadcrumb verbatim on macOS and Linux. Only the code is safe to record.
 */
export function mainWindowLoadErrorCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  if (code && /^ERR_[A-Z0-9_]+$/.test(code)) {
    return code
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\bERR_[A-Z0-9_]+/.exec(message)?.[0] ?? 'unknown'
}
