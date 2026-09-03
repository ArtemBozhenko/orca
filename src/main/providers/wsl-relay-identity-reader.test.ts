import { describe, expect, it, vi } from 'vitest'

import { createWslRelayIdentityReader } from './wsl-relay-identity-reader'

describe('wsl relay identity reader cost invariant', () => {
  it('does no identity work while idle', async () => {
    const readProcessIdentity = vi.fn()
    const reader = createWslRelayIdentityReader({ readProcessIdentity })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(readProcessIdentity).not.toHaveBeenCalled()
    expect(reader).toBeDefined()
  })
})
