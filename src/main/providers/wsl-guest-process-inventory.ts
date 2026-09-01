import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { parseWslGuestProcessInventoryPayload } from './wsl-guest-process-inventory-parser'
import type { WslGuestProcessInventory } from './wsl-guest-process-inventory-parser'

export { parseWslGuestProcessInventoryPayload } from './wsl-guest-process-inventory-parser'
export type {
  WslGuestProcessInventory,
  WslGuestProcessRow
} from './wsl-guest-process-inventory-parser'
export { resolveWslGuestForegroundProcess } from './wsl-guest-foreground-process-resolution'
export type {
  WslGuestForegroundResolution,
  WslGuestProcessAnchor
} from './wsl-guest-foreground-process-resolution'

export type WslGuestProcessInventoryRead =
  | { status: 'ok'; inventory: WslGuestProcessInventory }
  | { status: 'unverifiable'; reason: WslGuestProcessInventoryFailureReason }

export type WslGuestProcessInventoryFailureReason =
  | 'wsl_unavailable'
  | 'capture_failed'
  | 'capture_timed_out'
  | 'capture_malformed'
  | 'ps_unavailable'
  | 'boot_id_missing'

const INVENTORY_TIMEOUT_MS = 5_000
const INVENTORY_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const INVENTORY_TTL_MS = 500
const CAPTURE_NONCE_ENV = 'ORCA_WSL_CAPTURE_NONCE'

/**
 * The command is deliberately shell text behind the capture fence. `--exec`
 * is mandatory: a bare `--` lets wsl.exe expand `$name` in every argument.
 * The last `ps` field is read as one remainder so whitespace in args is kept.
 */
export const WSL_GUEST_INVENTORY_SCRIPT = [
  'set -u',
  '_orca_boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null) || exit 125',
  'case "$_orca_boot" in *[!A-Fa-f0-9-]*|"") exit 125 ;; esac',
  'printf "boot %s\\n" "$_orca_boot"',
  '_orca_ps=$(ps -axo pid=,ppid=,sid=,pgid=,tpgid=,tty=,stat=,args= 2>/dev/null) || exit 127',
  '_orca_expected=0',
  'while IFS= read -r _orca_line; do',
  '  [ -n "$_orca_line" ] && _orca_expected=$((_orca_expected + 1))',
  'done <<EOF',
  '$_orca_ps',
  'EOF',
  '_orca_seen=0',
  'while IFS= read -r _orca_line; do',
  '  [ -n "$_orca_line" ] || { continue; }',
  '  IFS=" " read -r _orca_pid _orca_ppid _orca_sid _orca_pgid _orca_tpgid _orca_tty _orca_stat _orca_args <<EOF',
  '$_orca_line',
  'EOF',
  '  { IFS= read -r _orca_procstat < "/proc/$_orca_pid/stat"; } 2>/dev/null || { printf "error start_time\\n"; exit 1; }',
  '  _orca_after=${_orca_procstat##*) }',
  '  IFS=" " read -r _orca_dummy1 _orca_dummy2 _orca_dummy3 _orca_dummy4 _orca_dummy5 _orca_dummy6 _orca_dummy7 _orca_dummy8 _orca_dummy9 _orca_dummy10 _orca_dummy11 _orca_dummy12 _orca_dummy13 _orca_dummy14 _orca_dummy15 _orca_dummy16 _orca_dummy17 _orca_dummy18 _orca_dummy19 _orca_start _orca_rest <<EOF',
  '$_orca_after',
  'EOF',
  '  case "$_orca_start" in ""|*[!0-9]*) printf "error start_time\\n"; exit 1 ;; esac',
  '  printf "row %s %s %s %s %s %s %s %s %s\\n" "$_orca_pid" "$_orca_ppid" "$_orca_sid" "$_orca_pgid" "$_orca_tpgid" "$_orca_tty" "$_orca_stat" "$_orca_start" "$_orca_args"',
  '  _orca_seen=$((_orca_seen + 1))',
  'done <<EOF',
  '$_orca_ps',
  'EOF',
  'printf "count %s %s\\n" "$_orca_seen" "$_orca_expected"'
].join('\n')

type ReaderDeps = {
  run?: (distro: string) => Promise<WslGuestProcessInventoryRead>
  now?: () => number
  ttlMs?: number
}

/** Construct a per-distro single-flight/TTL reader; exported for deterministic tests. */
export function createWslGuestProcessInventoryReader(deps: ReaderDeps = {}): {
  read: (distro: string) => Promise<WslGuestProcessInventoryRead>
  reset: () => void
} {
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? INVENTORY_TTL_MS
  const cached = new Map<string, { value: WslGuestProcessInventoryRead; at: number }>()
  const inFlight = new Map<string, Promise<WslGuestProcessInventoryRead>>()
  const run = deps.run ?? runWslGuestProcessInventory

  const read = (distro: string): Promise<WslGuestProcessInventoryRead> => {
    const cleanedDistro = distro.trim()
    const key = cleanedDistro.toLowerCase()
    const prior = cached.get(key)
    if (prior && now() - prior.at < ttlMs) {
      return Promise.resolve(prior.value)
    }
    const active = inFlight.get(key)
    if (active) {
      return active
    }
    const pending = run(cleanedDistro)
      .catch((): WslGuestProcessInventoryRead => ({
        status: 'unverifiable',
        reason: 'capture_failed'
      }))
      .then((value) => {
        cached.set(key, { value, at: now() })
        return value
      })
      .finally(() => {
        if (inFlight.get(key) === pending) {
          inFlight.delete(key)
        }
      })
    inFlight.set(key, pending)
    return pending
  }
  return {
    read,
    reset: () => {
      cached.clear()
      inFlight.clear()
    }
  }
}

async function runWslGuestProcessInventory(distro: string): Promise<WslGuestProcessInventoryRead> {
  const captureNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  const captured = buildWslCapturedLoginShellCommand(WSL_GUEST_INVENTORY_SCRIPT, captureNonce, {
    nonceEnvVar: CAPTURE_NONCE_ENV
  })
  let result
  try {
    const wslenvEntries = (process.env.WSLENV ?? '').split(':').filter(Boolean)
    const nonceEntry = `${CAPTURE_NONCE_ENV}/u`
    const nonceEntryIndex = wslenvEntries.findIndex(
      (entry) => entry.split('/')[0] === CAPTURE_NONCE_ENV
    )
    if (nonceEntryIndex === -1) {
      wslenvEntries.push(nonceEntry)
    } else {
      wslenvEntries[nonceEntryIndex] = nonceEntry
    }
    result = await runProcess({
      program: resolveWslExecutablePath(),
      args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
      env: {
        ...process.env,
        WSL_UTF8: '1',
        WSLENV: wslenvEntries.join(':'),
        [CAPTURE_NONCE_ENV]: captureNonce
      },
      timeoutMs: INVENTORY_TIMEOUT_MS,
      maxOutputBytes: INVENTORY_MAX_OUTPUT_BYTES
    })
  } catch {
    return { status: 'unverifiable', reason: 'wsl_unavailable' }
  }
  if (result.timedOut) {
    return { status: 'unverifiable', reason: 'capture_timed_out' }
  }
  if (result.code === 127) {
    return { status: 'unverifiable', reason: 'ps_unavailable' }
  }
  const payload = captured.readStdout(result.stdout)
  if (payload === null) {
    return { status: 'unverifiable', reason: 'capture_malformed' }
  }
  if (result.code !== 0) {
    return { status: 'unverifiable', reason: 'capture_failed' }
  }
  try {
    return { status: 'ok', inventory: parseWslGuestProcessInventoryPayload(payload, distro) }
  } catch (error) {
    return {
      status: 'unverifiable',
      reason:
        error instanceof Error && error.message === 'boot_id_missing'
          ? 'boot_id_missing'
          : 'capture_malformed'
    }
  }
}

const defaultReader = createWslGuestProcessInventoryReader()

export function readWslGuestProcessInventory(
  distro: string
): Promise<WslGuestProcessInventoryRead> {
  return defaultReader.read(distro)
}

export function resetWslGuestProcessInventoryForTests(): void {
  defaultReader.reset()
}
