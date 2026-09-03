import { describe, expect, it } from 'vitest'

import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { findTerminalTabIdForLeaf } from './workspace-session-terminal-membership-authority'
import { getTerminalLeafMembershipIndex } from './terminal-leaf-membership-index'

function layout(...leafIds: string[]): TerminalLayoutSnapshot {
  let root = { type: 'leaf' as const, leafId: leafIds[0] }
  for (const leafId of leafIds.slice(1)) {
    root = {
      type: 'split',
      direction: 'row',
      first: root,
      second: { type: 'leaf' as const, leafId }
    } as never
  }
  return { root, activeLeafId: leafIds[0], ptyIdsByLeafId: {} } as TerminalLayoutSnapshot
}

function session(layouts: Record<string, TerminalLayoutSnapshot>): WorkspaceSessionState {
  return { terminalLayoutsByTabId: layouts } as WorkspaceSessionState
}

describe('getTerminalLeafMembershipIndex', () => {
  it('maps every leaf in a split tree to its tab', () => {
    const index = getTerminalLeafMembershipIndex({
      'tab-a': layout('leaf-1', 'leaf-2', 'leaf-3'),
      'tab-b': layout('leaf-4')
    })
    expect([...index]).toEqual([
      ['leaf-1', 'tab-a'],
      ['leaf-2', 'tab-a'],
      ['leaf-3', 'tab-a'],
      ['leaf-4', 'tab-b']
    ])
  })

  it('keeps the first tab in record order when two layouts claim one leaf', () => {
    const layouts = { 'tab-a': layout('shared'), 'tab-b': layout('shared') }
    expect(getTerminalLeafMembershipIndex(layouts).get('shared')).toBe('tab-a')
    expect(findTerminalTabIdForLeaf(session(layouts), 'shared')).toBe('tab-a')
  })

  it('returns the same map instance for an unchanged record', () => {
    const layouts = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts)).toBe(getTerminalLeafMembershipIndex(layouts))
  })

  it('rebuilds when a layout object inside the same record is replaced', () => {
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
    layouts['tab-a'] = layout('leaf-9')
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBeUndefined()
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-9')).toBe('tab-a')
  })

  it('rebuilds when a tab is added to or removed from the same record', () => {
    const layouts: Record<string, TerminalLayoutSnapshot> = { 'tab-a': layout('leaf-1') }
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBe('tab-a')
    layouts['tab-b'] = layout('leaf-2')
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-2')).toBe('tab-b')
    delete layouts['tab-a']
    expect(getTerminalLeafMembershipIndex(layouts).get('leaf-1')).toBeUndefined()
  })

  it('answers misses and empty sessions the same way the linear scan did', () => {
    expect(findTerminalTabIdForLeaf(undefined, 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({}), 'leaf-1')).toBeUndefined()
    expect(findTerminalTabIdForLeaf(session({ 'tab-a': layout('leaf-1') }), 'nope')).toBeUndefined()
  })

  it('does not walk a layout tree again once the record is indexed', () => {
    let rootReads = 0
    const tracked = {
      get root() {
        rootReads += 1
        return layout('leaf-1').root
      },
      activeLeafId: 'leaf-1',
      ptyIdsByLeafId: {}
    } as unknown as TerminalLayoutSnapshot
    const layouts = { 'tab-a': tracked }
    for (let i = 0; i < 50; i += 1) {
      findTerminalTabIdForLeaf(session(layouts), `leaf-${i}`)
    }
    expect(rootReads).toBe(1)
  })
})
