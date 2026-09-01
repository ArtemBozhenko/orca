import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (...args: unknown[]) => runProcessMock(...args)
}))
import {
  createWslGuestProcessInventoryReader,
  parseWslGuestProcessInventoryPayload,
  readWslGuestProcessInventory,
  resetWslGuestProcessInventoryForTests,
  resolveWslGuestForegroundProcess,
  WSL_GUEST_INVENTORY_SCRIPT
} from './wsl-guest-process-inventory'

const bootId = '01234567-89ab-cdef-0123-456789abcdef'

function payload(rows: string, count = rows ? rows.split('\n').length : 0): string {
  return `boot ${bootId}\n${rows}${rows ? '\n' : ''}count ${count} ${count}\n`
}

describe('WSL guest process inventory', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it('keeps the guest inventory script valid for /bin/sh', () => {
    expect(() => execFileSync('sh', ['-n'], { input: WSL_GUEST_INVENTORY_SCRIPT })).not.toThrow()
  })

  it('reads proc start times without forking cat per process', () => {
    expect(WSL_GUEST_INVENTORY_SCRIPT).toContain(
      'IFS= read -r _orca_procstat < "/proc/$_orca_pid/stat"'
    )
    expect(WSL_GUEST_INVENTORY_SCRIPT).not.toContain('cat "/proc/$_orca_pid/stat"')
  })

  it('parses fixed fields and preserves whitespace in args', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload('row 100 90 90 100 100 pts/0 Sl+ 12345 /usr/bin/node --name "a b" --x'),
      'Ubuntu'
    )
    expect(inventory.rows[0]).toMatchObject({
      pid: 100,
      ppid: 90,
      sid: 90,
      pgid: 100,
      tpgid: 100,
      tty: 'pts/0',
      stat: 'Sl+',
      startTimeTicks: 12345,
      command: '/usr/bin/node --name "a b" --x'
    })
  })

  it('keeps trailing spaces in the command remainder', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload('row 100 90 90 100 100 pts/0 Sl+ 12345 tool arg   '),
      'Ubuntu'
    )
    expect(inventory.rows[0]?.command).toBe('tool arg   ')
  })

  it('rejects a partial capture instead of treating it as an empty inventory', () => {
    expect(() =>
      parseWslGuestProcessInventoryPayload(`boot ${bootId}\ncount 0 1\n`, 'Ubuntu')
    ).toThrow('row_count_mismatch')
  })

  it('fences boot, start-time, tty, and foreground group before recognizing agents', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload(
        [
          'row 100 90 90 100 120 pts/0 Ss+ 12345 bash',
          'row 120 100 100 120 120 pts/0 Sl+ 54321 codex --flag'
        ].join('\n'),
        2
      ),
      'Ubuntu'
    )
    const resolved = resolveWslGuestForegroundProcess(inventory, {
      distro: 'Ubuntu',
      bootId,
      shellPid: 100,
      shellStartTime: 12345,
      tty: '/dev/pts/0'
    })
    expect(resolved).toMatchObject({ status: 'live', processName: 'codex' })
    if (resolved.status === 'live') {
      expect(resolved.anchor).toMatchObject({
        bootId,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    }
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId: 'different',
        shellPid: 100,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'boot_id_mismatch' })
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId,
        shellPid: 100,
        shellStartTime: 999,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'pid_reused' })
  })

  it('does not claim identity across a multiplexer boundary', () => {
    const inventory = parseWslGuestProcessInventoryPayload(
      payload(
        [
          'row 100 90 90 100 110 pts/0 Ss+ 12345 bash',
          'row 110 100 100 110 110 pts/0 S+ 12346 tmux new-session',
          'row 120 110 110 120 120 pts/1 Sl+ 12347 codex'
        ].join('\n'),
        3
      ),
      'Ubuntu'
    )
    expect(
      resolveWslGuestForegroundProcess(inventory, {
        distro: 'Ubuntu',
        bootId,
        shellPid: 100,
        shellStartTime: 12345,
        tty: '/dev/pts/0'
      })
    ).toEqual({ status: 'unverifiable', reason: 'multiplexer_boundary' })
  })

  it('single-flights and memoizes independently per distro', async () => {
    let calls = 0
    let now = 0
    const reader = createWslGuestProcessInventoryReader({
      now: () => now,
      run: async (distro) => {
        calls += 1
        return {
          status: 'ok',
          inventory: { distro, bootId, rows: [] }
        }
      }
    })
    const [a, b] = await Promise.all([reader.read(' Ubuntu '), reader.read('ubuntu')])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
    await reader.read('Debian')
    expect(calls).toBe(2)
    now = 501
    await reader.read('Ubuntu')
    expect(calls).toBe(3)
  })

  it.each([1, 8, 32])('uses one guest inventory for a %s-pane burst', async (paneCount) => {
    let calls = 0
    const reader = createWslGuestProcessInventoryReader({
      run: async (distro) => {
        calls += 1
        return { status: 'ok', inventory: { distro, bootId, rows: [] } }
      }
    })
    await Promise.all(Array.from({ length: paneCount }, () => reader.read('Ubuntu')))
    expect(calls).toBe(1)
  })

  it('uses the fenced --exec command and reports a missing ps as unverifiable', async () => {
    runProcessMock.mockResolvedValue({ code: 127, stdout: '', stderr: '', timedOut: false })
    resetWslGuestProcessInventoryForTests()
    await expect(readWslGuestProcessInventory('Ubuntu')).resolves.toEqual({
      status: 'unverifiable',
      reason: 'ps_unavailable'
    })
    const spec = runProcessMock.mock.calls[0]?.[0]
    expect(spec.args).toContain('--exec')
    expect(spec.args).toContain('sh')
    expect(spec.args.join(' ')).not.toMatch(/__ORCA_WSL_CAPTURE_BEGIN_[^$]/)
    expect(spec.env.ORCA_WSL_CAPTURE_NONCE).toMatch(/^[a-z0-9]+$/)
  })
})
