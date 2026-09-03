/**
 * FIFO-bounded memo for a pure `(key: string) => T`.
 *
 * Insertion-ordered eviction: the oldest key is the one whose input has been superseded longest, so
 * it is the least likely to be asked for again. Entries hold a reference to a string the caller
 * already retains, so a live entry costs the map slot and nothing else.
 */
export function memoizeByStringKey<T>(
  compute: (key: string) => T,
  maxEntries: number
): (key: string) => T {
  // Boxed values so `undefined`/`null` results are still cache hits.
  const cache = new Map<string, { value: T }>()
  return (key: string): T => {
    const cached = cache.get(key)
    if (cached) {
      return cached.value
    }
    const value = compute(key)
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next()
      if (!oldest.done) {
        cache.delete(oldest.value)
      }
    }
    cache.set(key, { value })
    return value
  }
}
