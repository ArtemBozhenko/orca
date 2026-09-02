import { describe, expect, it } from 'vitest'
import { shouldStayColdForDeliberateSleep } from './deliberate-sleep-cold-start'

const sleptWorktree = 'wt-slept'

function input(overrides: Partial<Parameters<typeof shouldStayColdForDeliberateSleep>[0]> = {}) {
  return {
    hasQueuedStartup: false,
    isPaneVisible: false,
    hasSleepIntent: true,
    activeWorktreeId: 'wt-other',
    worktreeId: sleptWorktree,
    ...overrides
  }
}

describe('shouldStayColdForDeliberateSleep', () => {
  it('suppresses an ambient connect after unrelated activation', () => {
    expect(shouldStayColdForDeliberateSleep(input())).toBe(true)
  })

  it('suppresses a slept workspace when no workspace is active', () => {
    expect(shouldStayColdForDeliberateSleep(input({ activeWorktreeId: null }))).toBe(true)
  })

  it('allows explicit activation to create the terminal', () => {
    expect(shouldStayColdForDeliberateSleep(input({ activeWorktreeId: sleptWorktree }))).toBe(false)
  })

  it('allows visible panes and queued startups', () => {
    expect(shouldStayColdForDeliberateSleep(input({ isPaneVisible: true }))).toBe(false)
    expect(shouldStayColdForDeliberateSleep(input({ hasQueuedStartup: true }))).toBe(false)
  })

  it('does not suppress workspaces without a deliberate sleep marker', () => {
    expect(shouldStayColdForDeliberateSleep(input({ hasSleepIntent: false }))).toBe(false)
  })
})
