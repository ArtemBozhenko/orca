/**
 * `setWorktreeMetaForHost` puts one object in both `worktreeMeta` and `worktreeMetaByIdentity`, so
 * a heavy profile serializes every metadata row twice. On a measured 3.64 MB install 1,347 of
 * 1,349 locator rows were byte-identical to their identity twin and cost 611 KB per save.
 *
 * These tests drive the real Store over a seeded corpus that contains every shape the projection
 * has to get right — identical twins, divergent twins, rows with no identity at all, one locator
 * claimed by two hosts, an alias whose locator row was pruned away, a dangling identity key, and
 * an ambiguous alias with two instances behind one locator —
 * and pin the properties that make the omission safe: load(save(x)) deep-equals x, an
 * old-serializer file and a new-serializer file load to the same state, and no `worktreeMeta`
 * value is ever a non-object (a downgraded build reads that as corruption and deletes the row's
 * lineage companions with it).
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const REPO_ID = 'repo-1'
const LOCAL = 'local'
const REMOTE = 'ssh:user@host'
const TWIN_ROWS = 400
/** Recent enough that the 30-day stale-metadata GC leaves the fixture alone. */
const RECENTLY = Date.now()

/** Seeded so the corpus is the same on every run and a failure is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const stores: InstanceType<typeof Store>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = new Store({ dataFile })
  stores.push(store)
  return store
}

function tempDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-alias-projection-'))), 'orca-data.json')
}

function worktreeId(index: number): string {
  return `${REPO_ID}::/tmp/wt-${index}`
}

/** Every optional slot exercised on a fraction of rows, so a row that must stay written does. */
function meta(index: number, random: () => number, overrides: Partial<WorktreeMeta> = {}) {
  const rich = random() < 0.25
  return {
    instanceId: `instance-${index}`,
    hostId: LOCAL,
    displayName: `workspace-${index}`,
    comment: rich ? `note ${index}` : '',
    linkedIssue: null,
    linkedPR: rich ? index : null,
    linkedLinearIssue: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: random() < 0.3,
    isPinned: rich,
    sortOrder: RECENTLY + index,
    manualOrder: rich ? index : undefined,
    lastActivityAt: RECENTLY + index,
    createdAt: RECENTLY,
    baseRef: rich ? 'main' : undefined,
    workspaceStatus: 'none',
    ...overrides
  } as WorktreeMeta
}

type Fixture = {
  state: PersistedState
  /** Locator ids whose row the identity map cannot rebuild, so it must stay on disk. */
  irreducible: string[]
}

/**
 * A file in the pre-change shape: every alias' identity row duplicated into `worktreeMeta`, which
 * is exactly what the old serializer wrote.
 */
function buildFixture(): Fixture {
  const random = seededRandom(20_260_903)
  const worktreeMeta: Record<string, WorktreeMeta> = {}
  const worktreeMetaByIdentity: Record<string, WorktreeMeta> = {}
  const worktreeIdentityAliases: Record<string, string[]> = {}
  const irreducible: string[] = []

  const link = (id: string, host: string, row: WorktreeMeta): string => {
    const identityKey = canonicalWorktreeIdentity({
      worktreeId: id,
      executionHostId: host as never,
      instanceId: row.instanceId as string
    })
    worktreeMetaByIdentity[identityKey] = row
    worktreeIdentityAliases[composeWorktreeHostIdentity(host as never, id)] = [identityKey]
    return identityKey
  }

  // 1. The common case: the identity row and the locator row are the same value.
  for (let index = 0; index < TWIN_ROWS; index++) {
    const row = meta(index, random)
    worktreeMeta[worktreeId(index)] = { ...row }
    link(worktreeId(index), LOCAL, row)
  }
  // 2. Divergent twin: the locator row carries a value the identity row does not.
  const divergent = worktreeId(TWIN_ROWS)
  const divergentRow = meta(TWIN_ROWS, random)
  worktreeMeta[divergent] = { ...divergentRow, displayName: 'locator-only-name' }
  link(divergent, LOCAL, divergentRow)
  irreducible.push(divergent)
  // 3. No identity twin at all, and no hostId — the shape of Orca's synthetic pseudo-worktrees.
  for (const pseudo of ['global-floating-terminal', 'onboarding-setup-terminal']) {
    worktreeMeta[pseudo] = meta(0, random, { hostId: undefined, displayName: pseudo })
    irreducible.push(pseudo)
  }
  // 4. One locator claimed by two hosts: nothing on disk records which one owns the projection.
  const contested = worktreeId(TWIN_ROWS + 1)
  const localClaim = meta(TWIN_ROWS + 1, random)
  const remoteClaim = meta(TWIN_ROWS + 1, random, {
    hostId: REMOTE as never,
    instanceId: `instance-${TWIN_ROWS + 1}-remote`,
    lastActivityAt: RECENTLY + 99_999
  })
  worktreeMeta[contested] = { ...localClaim }
  link(contested, LOCAL, localClaim)
  link(contested, REMOTE, remoteClaim)
  irreducible.push(contested)
  // 5. An alias whose locator row a host-scoped prune already removed: rebuilding it would
  //    resurrect a workspace the user deleted.
  const voided = worktreeId(TWIN_ROWS + 2)
  link(voided, REMOTE, meta(TWIN_ROWS + 2, random, { hostId: REMOTE as never }))
  // 6. A dangling identity key: the alias points at a row that is not there.
  const dangling = worktreeId(TWIN_ROWS + 3)
  worktreeMeta[dangling] = meta(TWIN_ROWS + 3, random)
  worktreeIdentityAliases[composeWorktreeHostIdentity(LOCAL, dangling)] = ['wt2:local:missing']
  irreducible.push(dangling)
  // 7. An ambiguous alias — two instances behind one locator. `setWorktreeMetaForHost` refuses to
  //    write one, so it is a repair state and its locator row must stay written in full.
  const ambiguous = worktreeId(TWIN_ROWS + 4)
  const claimA = meta(TWIN_ROWS + 4, random)
  const claimB = meta(TWIN_ROWS + 4, random, {
    instanceId: `instance-${TWIN_ROWS + 4}-b`,
    displayName: 'second-instance',
    lastActivityAt: RECENTLY + 99_999
  })
  worktreeMeta[ambiguous] = { ...claimA }
  const ambiguousKey = link(ambiguous, LOCAL, claimA)
  const secondKey = canonicalWorktreeIdentity({
    worktreeId: ambiguous,
    executionHostId: LOCAL as never,
    instanceId: claimB.instanceId as string
  })
  worktreeMetaByIdentity[secondKey] = claimB
  worktreeIdentityAliases[composeWorktreeHostIdentity(LOCAL, ambiguous)] = [ambiguousKey, secondKey]
  irreducible.push(ambiguous)

  return {
    state: {
      // Registered: the load-time deregistered-repo sweep drops residue rows for unknown repos.
      repos: [{ id: REPO_ID, name: REPO_ID, path: '/tmp/repo-1', worktreesPath: '/tmp' }],
      projects: [],
      worktreeMeta,
      worktreeMetaByIdentity,
      worktreeIdentityAliases,
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    } as unknown as PersistedState,
    irreducible
  }
}

function writeFixture(dataFile: string, state: PersistedState): void {
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
}

function snapshot(store: InstanceType<typeof Store>) {
  return {
    meta: structuredClone(store.getAllWorktreeMeta()),
    local: structuredClone(store.getAllWorktreeMetaForHost(LOCAL)),
    remote: structuredClone(store.getAllWorktreeMetaForHost(REMOTE as never))
  }
}

describe('worktree meta alias projection', () => {
  it('round-trips every corpus shape and writes only the rows the identity map cannot rebuild', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)

    // One load+flush first, so the baseline is not comparing against the one-time settings
    // migrations a synthetic fixture triggers (same reason as state-write-round-trip.test.ts).
    openStore(dataFile).flush()

    const loaded = openStore(dataFile)
    const before = snapshot(loaded)
    loaded.flush()
    const rewritten = readFileSync(dataFile, 'utf-8')
    const onDisk = JSON.parse(rewritten) as PersistedState

    // The counter this change exists for: 400 identical twins leave the file, the rest stay.
    expect(Object.keys(onDisk.worktreeMeta).sort()).toEqual([...fixture.irreducible].sort())
    // ...and the identity map, which is what rebuilds them, is untouched.
    expect(Object.keys(onDisk.worktreeMetaByIdentity ?? {})).toHaveLength(TWIN_ROWS + 6)
    // The pruned locator is recorded so the load path does not resurrect it.
    expect(onDisk.worktreeMetaAliasesWithoutLegacyRow).toEqual([
      composeWorktreeHostIdentity(REMOTE as never, worktreeId(TWIN_ROWS + 2))
    ])
    // Downgrade safety: an older build treats a non-object `worktreeMeta` value as corruption and
    // deletes that locator's lineage companions with it. Absence is a shape it already handles.
    for (const value of Object.values(onDisk.worktreeMeta)) {
      expect(typeof value).toBe('object')
      expect(value).not.toBeNull()
    }

    // load(save(x)) deep-equals x, for every reader of the metadata maps.
    const reloaded = openStore(dataFile)
    expect(reloaded.getAllWorktreeMeta()).toEqual(before.meta)
    expect(reloaded.getAllWorktreeMetaForHost(LOCAL)).toEqual(before.local)
    expect(reloaded.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(before.remote)
    // The removed locator stays removed rather than reappearing from its surviving alias.
    expect(reloaded.getAllWorktreeMeta()).not.toHaveProperty(worktreeId(TWIN_ROWS + 2))
    // The contested locator keeps the host that owned the projection, not the newer claim.
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 1)]?.hostId).toBe(LOCAL)
    // The ambiguous locator keeps its own row, not the newer instance behind the same alias.
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 4)]?.displayName).toBe(
      `workspace-${TWIN_ROWS + 4}`
    )

    // A quiet app does not rewrite the file with new content on the next flush.
    reloaded.flush()
    expect(readFileSync(dataFile, 'utf-8')).toBe(rewritten)
  })

  it('rebuilds the locator rows as the same objects the identity map holds', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)
    openStore(dataFile).flush()

    const store = openStore(dataFile)
    const rebuilt = store.getAllWorktreeMeta()
    // JSON.parse splits the one object the write path shared into two; the rebuild puts it back,
    // worth ~0.46 MB of heap on the measured 3.64 MB profile.
    let shared = 0
    for (let index = 0; index < TWIN_ROWS; index++) {
      if (store.getWorktreeMetaForHost(worktreeId(index), LOCAL) === rebuilt[worktreeId(index)]) {
        shared++
      }
    }
    expect(shared).toBe(TWIN_ROWS)
  })

  it('loads an old-serializer file and a new-serializer file to the same state', () => {
    const fixture = buildFixture()
    const legacyFile = tempDataFile()
    writeFixture(legacyFile, fixture.state)
    const fromLegacy = openStore(legacyFile)
    // A legacy file carries no projection marker, so an alias with no locator row there means the
    // row was removed — the rebuild must not fire and resurrect it.
    expect(fromLegacy.getAllWorktreeMeta()).not.toHaveProperty(worktreeId(TWIN_ROWS + 2))
    expect(Object.keys(fromLegacy.getAllWorktreeMeta())).toHaveLength(
      Object.keys(fixture.state.worktreeMeta).length
    )
    // Writing it back produces the new, projected shape in place.
    fromLegacy.flush()

    const compactFile = tempDataFile()
    writeFileSync(compactFile, readFileSync(legacyFile))
    const fromCompact = openStore(compactFile)

    expect(fromCompact.getAllWorktreeMeta()).toEqual(fromLegacy.getAllWorktreeMeta())
    expect(fromCompact.getAllWorktreeMetaForHost(LOCAL)).toEqual(
      fromLegacy.getAllWorktreeMetaForHost(LOCAL)
    )
    expect(fromCompact.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(
      fromLegacy.getAllWorktreeMetaForHost(REMOTE as never)
    )
  })

  it('keeps every row when the alias map is missing or unreadable', () => {
    for (const aliases of [undefined, null, [], { 'local|x': 'not-an-array' }]) {
      const fixture = buildFixture()
      const dataFile = tempDataFile()
      writeFixture(dataFile, {
        ...fixture.state,
        worktreeIdentityAliases: aliases as never
      })
      const store = openStore(dataFile)
      // Nothing resolvable, so nothing is projected away and nothing is dropped.
      expect(Object.keys(store.getAllWorktreeMeta()).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
      store.flush()
      const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
      expect(Object.keys(onDisk.worktreeMeta).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
    }
  })
})
