import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'

type LayoutsByTabId = Record<string, TerminalLayoutSnapshot>

type LeafMembershipIndex = {
  /** First tab (in record order) whose layout tree holds the leaf — matches the linear scan. */
  readonly tabIdByLeafId: ReadonlyMap<string, string>
  /** Layout objects the index was built from, used to detect in-place record edits. */
  readonly builtFrom: ReadonlyMap<string, TerminalLayoutSnapshot>
}

const EMPTY_INDEX: LeafMembershipIndex = {
  tabIdByLeafId: new Map(),
  builtFrom: new Map()
}

// Sessions hand back the same layouts record across reads, so one index serves every lookup.
const indexByLayoutsRecord = new WeakMap<LayoutsByTabId, LeafMembershipIndex>()

function addLeafIds(
  node: TerminalPaneLayoutNode | null | undefined,
  tabId: string,
  tabIdByLeafId: Map<string, string>
): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    if (!tabIdByLeafId.has(node.leafId)) {
      tabIdByLeafId.set(node.leafId, tabId)
    }
    return
  }
  addLeafIds(node.first, tabId, tabIdByLeafId)
  addLeafIds(node.second, tabId, tabIdByLeafId)
}

/**
 * Why an identity check and not just the WeakMap: a few writers copy the layouts record and then
 * assign into the copy, so the record can be new while most layout objects are shared — and a
 * cached index must not outlive a replaced layout. Comparing layout references is O(tabs) pointer
 * loads with no allocation, versus the rebuild's set-per-tab tree walk.
 */
function isIndexCurrent(index: LeafMembershipIndex, layouts: LayoutsByTabId): boolean {
  let seen = 0
  for (const tabId of Object.keys(layouts)) {
    if (index.builtFrom.get(tabId) !== layouts[tabId]) {
      return false
    }
    seen += 1
  }
  return seen === index.builtFrom.size
}

function buildIndex(layouts: LayoutsByTabId): LeafMembershipIndex {
  const tabIdByLeafId = new Map<string, string>()
  const builtFrom = new Map<string, TerminalLayoutSnapshot>()
  for (const tabId of Object.keys(layouts)) {
    const layout = layouts[tabId]
    builtFrom.set(tabId, layout)
    addLeafIds(layout?.root, tabId, tabIdByLeafId)
  }
  return { tabIdByLeafId, builtFrom }
}

/** leafId -> owning tabId for one session's layouts, rebuilt only when a layout object changes. */
export function getTerminalLeafMembershipIndex(
  layouts: LayoutsByTabId | undefined
): ReadonlyMap<string, string> {
  if (!layouts) {
    return EMPTY_INDEX.tabIdByLeafId
  }
  const cached = indexByLayoutsRecord.get(layouts)
  if (cached && isIndexCurrent(cached, layouts)) {
    return cached.tabIdByLeafId
  }
  const built = buildIndex(layouts)
  indexByLayoutsRecord.set(layouts, built)
  return built.tabIdByLeafId
}
