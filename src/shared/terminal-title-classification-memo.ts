import { memoizeByStringKey } from './bounded-string-key-memo'

/**
 * Bounded memo for pure `(title: string) => T` terminal-title classifiers.
 *
 * Why: the sidebar cards and tab strip re-derive agent identity/status from
 * every pane title inside zustand selectors and render bodies, so an UNCHANGED
 * title was re-tested against every agent-name regex on every store write —
 * thousands of classifications per second while the app sat idle. Every
 * classifier below depends on nothing but the title string, so the verdict is
 * reusable until the title itself changes; a new title is simply a new key, so
 * there is no staleness window and no invalidation signal to miss.
 */

/**
 * Cap: comfortably above the live working set (one title per open pane plus
 * retained rows) so steady-state hit rate stays ~100%, small enough that the
 * map cannot grow with session length. Entries hold a reference to a string the
 * store already retains, so the marginal cost is the map entry itself.
 */
const MAX_MEMOIZED_TITLES = 1024

export function memoizeTitleClassification<T>(
  classify: (title: string) => T
): (title: string) => T {
  return memoizeByStringKey(classify, MAX_MEMOIZED_TITLES)
}
