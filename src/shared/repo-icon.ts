import { memoizeByStringKey } from './bounded-string-key-memo'
import { validateRasterImageDataUri } from './image-data-uri'

export type RepoIconImageSource = 'upload' | 'file' | 'favicon' | 'github'

export type RepoIcon =
  | { type: 'lucide'; name: string }
  | { type: 'emoji'; emoji: string }
  | { type: 'image'; src: string; source: RepoIconImageSource; label?: string }

export const MAX_REPO_ICON_UPLOAD_BYTES = 256 * 1024
export const MAX_REPO_ICON_DATA_URL_LENGTH = 400 * 1024

const LUCIDE_ICON_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
const isRepoIconImageSource = (value: string): value is RepoIconImageSource =>
  value === 'upload' || value === 'file' || value === 'favicon' || value === 'github'

export function faviconUrlFromWebsite(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return null
  }

  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return null
    }
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`
  } catch {
    return null
  }
}

type GitHubAvatarSlug = { owner: string; repo: string; host?: string }

/**
 * Pick the owner whose avatar represents a repo, given its `origin` and fork parent.
 * Why: a same-name fork is a personal copy, so it reads as the parent project; a
 * renamed fork is its own project and keeps its own owner.
 */
export function githubAvatarSlug(
  origin: GitHubAvatarSlug | null | undefined,
  upstream: GitHubAvatarSlug | null | undefined
): GitHubAvatarSlug | null {
  const renamedFork =
    origin && upstream && origin.repo.toLowerCase() !== upstream.repo.toLowerCase()
  return renamedFork ? origin : (upstream ?? origin ?? null)
}

// Why: shared default icon URL/label for main auto-detect and the renderer picker.
export function githubAvatarIcon(slug: GitHubAvatarSlug): RepoIcon {
  // Why: GHES uses the same /<login>.png avatar path as github.com.
  const host = normalizeGitHubAvatarHost(slug.host)
  return {
    type: 'image',
    src: `https://${host}/${encodeURIComponent(slug.owner)}.png?size=64`,
    source: 'github',
    label: `${slug.owner}/${slug.repo}`
  }
}

function normalizeGitHubAvatarHost(rawHost?: string): string {
  const candidate = rawHost?.trim().toLowerCase() || 'github.com'
  try {
    const url = new URL(`https://${candidate}`)
    // Why: only bare hostnames — reject credentials, paths, query, or hash.
    // Explicit default port 443 is stripped by URL serialization, so accept the
    // canonical `hostname:443` form too or valid GHES avatars on 443 fall back.
    return !url.username &&
      !url.password &&
      (url.host === candidate || `${url.host}:443` === candidate) &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.host
      : 'github.com'
  } catch {
    return 'github.com'
  }
}

/**
 * Cap: comfortably above the icon working set of a heavy multi-repo user, small enough that a
 * session of icon edits cannot grow the map without limit. Keys are the same `src` strings the
 * persisted repo list already holds, so a live entry costs the map slot and nothing else.
 */
const MAX_MEMOIZED_ICON_SOURCES = 64

function computeIsSupportedImageSrc(src: string, source: RepoIconImageSource): boolean {
  if (source === 'upload') {
    return (
      /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(src) &&
      validateRasterImageDataUri(src) !== null
    )
  }

  if (source === 'file') {
    return (
      /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(src) &&
      validateRasterImageDataUri(src) !== null
    )
  }

  let url: URL
  try {
    url = new URL(src)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') {
    return false
  }

  if (source === 'github') {
    // Why: only owner-avatar paths; no credentials (GHES hosts may be internal).
    return !url.username && !url.password && /^\/[^/?#]+\.png$/i.test(url.pathname)
  }

  return url.hostname === 'www.google.com' && url.pathname === '/s2/favicons'
}

/**
 * Why: repo icons are immutable persisted strings, so a given `src` always validates the same way
 * and there is no invalidation window — a changed icon is simply a new key. `getRepos()` re-hydrates
 * every repo on every call, and validating one inline data URI means scanning it twice with a regex
 * and base64-decoding its header.
 *
 * One memo per source rather than a composite key, because V8 caches a string's hash in the string
 * itself: keying on `src` makes a 400 KB data URI an O(1) lookup, while `${source}\0${src}` would
 * rebuild and rehash the whole thing on every call.
 */
const memoizedIsSupportedImageSrc: Record<RepoIconImageSource, (src: string) => boolean> = {
  upload: memoizeByStringKey(
    (src) => computeIsSupportedImageSrc(src, 'upload'),
    MAX_MEMOIZED_ICON_SOURCES
  ),
  file: memoizeByStringKey(
    (src) => computeIsSupportedImageSrc(src, 'file'),
    MAX_MEMOIZED_ICON_SOURCES
  ),
  favicon: memoizeByStringKey(
    (src) => computeIsSupportedImageSrc(src, 'favicon'),
    MAX_MEMOIZED_ICON_SOURCES
  ),
  github: memoizeByStringKey(
    (src) => computeIsSupportedImageSrc(src, 'github'),
    MAX_MEMOIZED_ICON_SOURCES
  )
}

export function sanitizeRepoIcon(value: unknown): RepoIcon | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const candidate = value as Record<string, unknown>
  if (candidate.type === 'lucide') {
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
    if (!LUCIDE_ICON_NAME_PATTERN.test(name) || name.length > 40) {
      return undefined
    }
    return { type: 'lucide', name }
  }

  if (candidate.type === 'emoji') {
    const emoji = typeof candidate.emoji === 'string' ? candidate.emoji.trim() : ''
    if (!emoji || emoji.length > 16) {
      return undefined
    }
    return { type: 'emoji', emoji }
  }

  if (candidate.type === 'image') {
    const src = typeof candidate.src === 'string' ? candidate.src.trim() : ''
    const source = typeof candidate.source === 'string' ? candidate.source : ''
    if (!isRepoIconImageSource(source) || src.length > MAX_REPO_ICON_DATA_URL_LENGTH) {
      return undefined
    }
    if (!memoizedIsSupportedImageSrc[source](src)) {
      return undefined
    }
    const label = typeof candidate.label === 'string' ? candidate.label.trim().slice(0, 80) : ''
    return {
      type: 'image',
      src,
      source: source as RepoIconImageSource,
      ...(label ? { label } : {})
    }
  }

  return undefined
}
