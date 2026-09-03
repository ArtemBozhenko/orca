/**
 * `setWorktreeMetaForHost` stores one object in both `worktreeMeta` and `worktreeMetaByIdentity`,
 * so the profile serializes every metadata row twice. On a measured 3.64 MB install, 1,347 of
 * 1,349 locator rows were byte-identical to their identity twin: 611 KB re-serialized on every
 * debounced save and re-parsed on every launch.
 *
 * The locator projection is therefore written only where the identity map cannot rebuild it, and
 * the rebuild reinstates the shared object reference that `JSON.parse` splits in two.
 *
 * Absence, not an in-value sentinel: a downgraded build reads a non-object `worktreeMeta` value as
 * corruption and deletes that locator's `worktreeLineageById` / `workspaceLineageByChildKey`
 * companions along with the row, and nothing can rebuild those. A missing key is a shape every
 * build already tolerates, and the identity map it falls back to is left untouched.
 */
import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { getWorktreeIdFromHostIdentity } from '../../../shared/worktree/host-qualified-identity'

type AliasProjectionState = Pick<
  PersistedState,
  'worktreeIdentityAliases' | 'worktreeMetaByIdentity'
>

/** Every slice of a parsed profile file the rebuild reads; `PersistedState` satisfies it. */
export type WorktreeMetaAliasProjectionSource = AliasProjectionState &
  Pick<PersistedState, 'worktreeMeta' | 'worktreeMetaAliasesWithoutLegacyRow'>

export type WorktreeMetaAliasProjection = {
  worktreeMeta: Record<string, WorktreeMeta>
  /** Always emitted: its presence is what marks a file as projected, so a legacy file — where an
   *  alias with no locator row means the row was genuinely removed — is never rebuilt from. */
  worktreeMetaAliasesWithoutLegacyRow: string[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Locators reachable from an alias, with every host that claims each one. */
function aliasesByWorktreeId(aliases: unknown): Map<string, string[]> {
  const byWorktreeId = new Map<string, string[]>()
  if (!isPlainRecord(aliases)) {
    return byWorktreeId
  }
  for (const alias of Object.keys(aliases)) {
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    const claimed = byWorktreeId.get(worktreeId)
    if (claimed) {
      claimed.push(alias)
    } else {
      byWorktreeId.set(worktreeId, [alias])
    }
  }
  return byWorktreeId
}

/**
 * The one alias that owns a locator's projection, or undefined when the locator is contested.
 *
 * Two hosts on one `worktreeId` are left alone: only the first known owner's row lands in
 * `worktreeMeta`, nothing on disk records which host that was, and object key order is not a
 * durable contract across a JSON round trip.
 */
function soleAliasForWorktreeId(aliases: readonly string[]): string | undefined {
  return aliases.length === 1 ? aliases[0] : undefined
}

/**
 * The row an alias names, taken at its first identity key.
 *
 * Index 0, not the newest-activity winner `resolveAliasIdentityKey` picks: the winner depends on
 * `lastActivityAt`, so a key added to the alias between the save and the load would rebuild a
 * DIFFERENT row than the one the writer compared against. Index 0 is stable under an append, and
 * a locator is only ever omitted while its alias is unambiguous.
 */
function aliasIdentity(
  state: AliasProjectionState,
  alias: string
): { meta: WorktreeMeta; ambiguous: boolean } | undefined {
  const identityKeys = state.worktreeIdentityAliases?.[alias]
  if (!Array.isArray(identityKeys) || identityKeys.length === 0) {
    return undefined
  }
  const meta = state.worktreeMetaByIdentity?.[identityKeys[0]]
  return isPlainRecord(meta)
    ? { meta: meta as WorktreeMeta, ambiguous: identityKeys.length > 1 }
    : undefined
}

/**
 * Serialize side, on the raw in-memory maps: an untouched row is the same object in both, so the
 * common case costs a reference check and never a deep compare.
 */
export function projectWorktreeMetaOntoAliases(
  worktreeMeta: Record<string, WorktreeMeta>,
  state: AliasProjectionState
): WorktreeMetaAliasProjection {
  const byWorktreeId = aliasesByWorktreeId(state.worktreeIdentityAliases)
  let projected: Record<string, WorktreeMeta> | undefined
  const withoutLegacyRow: string[] = []
  for (const [worktreeId, claimedBy] of byWorktreeId) {
    const alias = soleAliasForWorktreeId(claimedBy)
    const identity = alias ? aliasIdentity(state, alias) : undefined
    if (!alias || !identity) {
      continue
    }
    if (!Object.hasOwn(worktreeMeta, worktreeId)) {
      // A prune can drop the locator row and keep another host's alias; without this the rebuild
      // would resurrect a workspace the user removed. Recorded even for an ambiguous alias,
      // because the rebuild does not check ambiguity.
      withoutLegacyRow.push(alias)
      continue
    }
    // An ambiguous alias keeps its full row: `setWorktreeMetaForHost` refuses to write one, so it
    // is a repair state, and leaving it untouched preserves exactly today's bytes for it.
    const legacy = worktreeMeta[worktreeId]
    if (
      identity.ambiguous ||
      (legacy !== identity.meta && !isDeepStrictEqual(legacy, identity.meta))
    ) {
      continue
    }
    projected ??= { ...worktreeMeta }
    delete projected[worktreeId]
  }
  return {
    worktreeMeta: projected ?? worktreeMeta,
    // Sorted so a quiet app re-emits identical bytes regardless of alias insertion order.
    worktreeMetaAliasesWithoutLegacyRow: withoutLegacyRow.sort()
  }
}

/**
 * Load side. Runs before the metadata normalizers, and every unresolvable case keeps whatever the
 * file already held rather than inventing or dropping a row.
 */
export function hydrateWorktreeMetaAliasProjection(
  parsed: WorktreeMetaAliasProjectionSource
): Record<string, WorktreeMeta> {
  const worktreeMeta = parsed.worktreeMeta
  if (!isPlainRecord(worktreeMeta)) {
    return worktreeMeta
  }
  const rawWithoutLegacyRow = parsed.worktreeMetaAliasesWithoutLegacyRow
  if (!Array.isArray(rawWithoutLegacyRow)) {
    // A file the projection never touched: an alias with no locator row there means the row was
    // removed, not omitted, and rebuilding it would resurrect a deleted workspace.
    return worktreeMeta
  }
  const byWorktreeId = aliasesByWorktreeId(parsed.worktreeIdentityAliases)
  const withoutLegacyRow = new Set(rawWithoutLegacyRow)
  for (const [worktreeId, claimedBy] of byWorktreeId) {
    const alias = soleAliasForWorktreeId(claimedBy)
    if (!alias || withoutLegacyRow.has(alias) || Object.hasOwn(worktreeMeta, worktreeId)) {
      continue
    }
    const identity = aliasIdentity(parsed, alias)
    if (!identity) {
      continue
    }
    // Same reference in both maps, as every in-session write leaves it.
    worktreeMeta[worktreeId] = identity.meta
  }
  return worktreeMeta
}
