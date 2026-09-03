import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWslRelayIdentityReader } from './wsl-relay-identity-reader'

describe('wsl relay identity reader cost invariant', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports host cache age in addition to the relay capture age', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const readProcessIdentity = vi.fn().mockResolvedValue([
      {
        status: 'unverifiable' as const,
        reason: 'capture_failed',
        capturedAgeMs: 10
      }
    ])
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    const anchor = {
      distro: 'Ubuntu',
      bootId: '11111111-1111-1111-1111-111111111111',
      shellPid: 1,
      shellStartTime: 1,
      tty: '/dev/pts/1'
    }

    await expect(reader.read('Ubuntu', anchor)).resolves.toMatchObject({ capturedAgeMs: 10 })
    vi.setSystemTime(250)
    await expect(reader.read('Ubuntu', anchor)).resolves.toMatchObject({ capturedAgeMs: 260 })
    expect(readProcessIdentity).toHaveBeenCalledOnce()
  })
})
