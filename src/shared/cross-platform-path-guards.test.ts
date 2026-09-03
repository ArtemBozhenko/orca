/**
 * Proves the substring/char-code guards added to `cross-platform-path.ts` and `parseWslUncPath`
 * are pure fast paths: a seeded differential fuzz against the pre-guard copy in
 * `cross-platform-path-unguarded.test-fixture.ts`, plus counters that fail if the guards regress.
 */
import { describe, expect, it, afterEach } from 'vitest'
import * as guarded from './cross-platform-path'
import * as unguarded from './cross-platform-path-unguarded.test-fixture'
import { parseWslUncPath } from './wsl-paths'

// ─── Deterministic path generator ────────────────────────────────────

function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PREFIXES = [
  '',
  '/',
  '//',
  '///',
  '.',
  './',
  '../',
  'C:/',
  'c:\\',
  'Z:',
  '\\\\',
  '\\\\wsl.localhost\\Ubuntu',
  '//wsl.localhost/Ubuntu-22.04',
  '//WSL$/Debian',
  '\\\\wsl$\\ubuntu',
  '//server/share',
  '/mnt/c',
  '\\\\wsl.localhost\\Ubuntu\\mnt\\c'
]

// NFD + KELVIN SIGN are the folds `normalizeRuntimePathForComparison` is built around.
const SEGMENTS = [
  'home',
  'user',
  'orca',
  'workspaces',
  '..',
  '.',
  '',
  'a',
  'B',
  'wsl$',
  'wsl.localhost',
  'mnt',
  'c',
  'C',
  'répertoire',
  're\u0301pertoire',
  '\u212Aelvin',
  'Kelvin',
  'back\\slash',
  'sp ace',
  'Ubuntu'
]

const JOINERS = ['/', '/', '/', '//', '///', '\\', '\\\\']
const SUFFIXES = ['', '', '', '/', '//', '\\', '/.', '/..']

function generatePath(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  let path = pick(PREFIXES)
  const segmentCount = Math.floor(random() * 5)
  for (let index = 0; index < segmentCount; index++) {
    path += (path === '' ? '' : pick(JOINERS)) + pick(SEGMENTS)
  }
  return path + pick(SUFFIXES)
}

/** Roots that actually contain the candidate, so the matching branches get exercised too. */
function generateRoot(random: () => number, candidate: string): string {
  const roll = random()
  if (roll < 0.35) {
    const cut = Math.floor(random() * (candidate.length + 1))
    return candidate.slice(0, cut)
  }
  if (roll < 0.45) {
    return candidate
  }
  return generatePath(random)
}

// ─── Differential fuzz ───────────────────────────────────────────────

const FUZZ_ITERATIONS = 200_000

describe('guarded path normalization matches the pre-guard implementation', () => {
  it(`agrees on every export across ${FUZZ_ITERATIONS} seeded paths`, () => {
    const random = createRandom(0x5eed)
    const mismatches: string[] = []
    const record = (label: string, path: string, root: string): void => {
      if (mismatches.length < 5) {
        mismatches.push(`${label}: candidate=${JSON.stringify(path)} root=${JSON.stringify(root)}`)
      }
    }

    for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration++) {
      const path = generatePath(random)
      const root = generateRoot(random, path)
      const distro = Math.floor(random() * 2) === 0 ? 'Ubuntu' : 'debian'

      const singles: [string, (value: string) => unknown, (value: string) => unknown][] = [
        [
          'isWindowsAbsolutePathLike',
          guarded.isWindowsAbsolutePathLike,
          unguarded.isWindowsAbsolutePathLike
        ],
        [
          'isCaseInsensitiveRuntimeRoot',
          guarded.isCaseInsensitiveRuntimeRoot,
          unguarded.isCaseInsensitiveRuntimeRoot
        ],
        [
          'normalizeRuntimePathSeparators',
          guarded.normalizeRuntimePathSeparators,
          unguarded.normalizeRuntimePathSeparators
        ],
        [
          'normalizeRuntimePathForComparison',
          guarded.normalizeRuntimePathForComparison,
          unguarded.normalizeRuntimePathForComparison
        ],
        ['isRuntimePathAbsolute', guarded.isRuntimePathAbsolute, unguarded.isRuntimePathAbsolute],
        ['getRuntimePathBasename', guarded.getRuntimePathBasename, unguarded.getRuntimePathBasename]
      ]
      for (const [label, left, right] of singles) {
        if (left(path) !== right(path)) {
          record(label, path, root)
        }
      }

      const identity = guarded.getLocalWindowsWslPathIdentity(path)
      const expectedIdentity = unguarded.getLocalWindowsWslPathIdentity(path)
      if (
        identity.normalizedPath !== expectedIdentity.normalizedPath ||
        identity.aliasComparisonPath !== expectedIdentity.aliasComparisonPath ||
        identity.isWslUnc !== expectedIdentity.isWslUnc
      ) {
        record('getLocalWindowsWslPathIdentity', path, root)
      }
      const wslUnc = parseWslUncPath(path)
      const expectedWslUnc = unguarded.parseWslUncPath(path)
      if (
        wslUnc?.distro !== expectedWslUnc?.distro ||
        wslUnc?.linuxPath !== expectedWslUnc?.linuxPath
      ) {
        record('parseWslUncPath', path, root)
      }
      if (
        guarded.areLocalWindowsWslPathAliases(root, path) !==
        unguarded.areLocalWindowsWslPathAliases(root, path)
      ) {
        record('areLocalWindowsWslPathAliases', path, root)
      }
      if (
        guarded.isWslUncPathForCallerLinuxPath(root, path, distro) !==
        unguarded.isWslUncPathForCallerLinuxPath(root, path, distro)
      ) {
        record('isWslUncPathForCallerLinuxPath', path, root)
      }
      if (
        guarded.isWslUncPathForLinuxMountedPath(root, path) !==
        unguarded.isWslUncPathForLinuxMountedPath(root, path)
      ) {
        record('isWslUncPathForLinuxMountedPath', path, root)
      }
      if (guarded.resolveRuntimePath(root, path) !== unguarded.resolveRuntimePath(root, path)) {
        record('resolveRuntimePath', path, root)
      }
      if (guarded.isPathInsideOrEqual(root, path) !== unguarded.isPathInsideOrEqual(root, path)) {
        record('isPathInsideOrEqual', path, root)
      }
      if (
        guarded.createNormalizedPathInsideOrEqualMatcher(root)(
          guarded.normalizeRuntimePathForComparison(path)
        ) !==
        unguarded.createNormalizedPathInsideOrEqualMatcher(root)(
          unguarded.normalizeRuntimePathForComparison(path)
        )
      ) {
        record('createNormalizedPathInsideOrEqualMatcher', path, root)
      }
      const expectedRelative = unguarded.relativePathInsideRoot(root, path)
      if (guarded.relativePathInsideRoot(root, path) !== expectedRelative) {
        record('relativePathInsideRoot', path, root)
      }
      const resolver = guarded.createRelativePathInsideRootResolver(root)
      if (resolver.resolve(path) !== expectedRelative) {
        record('createRelativePathInsideRootResolver.resolve', path, root)
      }
      if (resolver.comparisonRoot !== unguarded.normalizeRuntimePathForComparison(root)) {
        record('createRelativePathInsideRootResolver.comparisonRoot', path, root)
      }
    }

    expect(mismatches).toEqual([])
  }, 120_000)
})

// ─── The guards must not skip work that was actually needed ──────────

describe('guards still do the work when the fast path does not apply', () => {
  it('collapses doubled slashes', () => {
    expect(guarded.normalizeRuntimePathForComparison('/a//b///c')).toBe('/a/b/c')
    expect(guarded.normalizeRuntimePathSeparators('/a//b')).toBe('/a/b')
    expect(guarded.relativePathInsideRoot('/a', '/a//b//c')).toBe('b/c')
  })

  it('trims trailing slashes but keeps bare roots', () => {
    expect(guarded.normalizeRuntimePathForComparison('/a/b/')).toBe('/a/b')
    expect(guarded.normalizeRuntimePathForComparison('/a/b//')).toBe('/a/b')
    expect(guarded.normalizeRuntimePathForComparison('/')).toBe('/')
    expect(guarded.normalizeRuntimePathForComparison('C:/')).toBe('c:/')
  })

  it('folds backslashes only on Windows-shaped paths', () => {
    expect(guarded.normalizeRuntimePathForComparison('C:\\a\\b')).toBe('c:/a/b')
    expect(guarded.normalizeRuntimePathSeparators('C:\\a\\\\b')).toBe('C:/a/b')
    // Backslash is a legal POSIX filename character and must survive.
    expect(guarded.normalizeRuntimePathForComparison('/a/b\\c')).toBe('/a/b\\c')
  })

  it('still parses both WSL UNC aliases in either separator spelling', () => {
    expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toEqual({
      distro: 'Ubuntu',
      linuxPath: '/home/me'
    })
    expect(parseWslUncPath('//wsl$/Debian/srv')).toEqual({ distro: 'Debian', linuxPath: '/srv' })
    expect(guarded.normalizeRuntimePathForComparison('\\\\wsl.localhost\\Ubuntu\\Repo')).toBe(
      '//wsl/ubuntu/Repo'
    )
    expect(parseWslUncPath('/wsl.localhost/Ubuntu/home')).toBeNull()
    expect(parseWslUncPath('/')).toBeNull()
    expect(parseWslUncPath('')).toBeNull()
  })
})

// ─── Regression guards: counted work, not wall clock ─────────────────

const originalReplace = String.prototype.replace
const originalNormalize = String.prototype.normalize

afterEach(() => {
  String.prototype.replace = originalReplace
  String.prototype.normalize = originalNormalize
})

function countReplaceCalls(run: () => void): number {
  let calls = 0
  String.prototype.replace = function (this: string, ...args: never[]) {
    calls++
    return originalReplace.apply(this, args as never)
  } as typeof String.prototype.replace
  try {
    run()
  } finally {
    String.prototype.replace = originalReplace
  }
  return calls
}

function countNormalizeCalls(run: () => void): number {
  let calls = 0
  String.prototype.normalize = function (this: string, ...args: never[]) {
    calls++
    return originalNormalize.apply(this, args as never)
  } as typeof String.prototype.normalize
  try {
    run()
  } finally {
    String.prototype.normalize = originalNormalize
  }
  return calls
}

const CLEAN_POSIX_PATH =
  '/Users/nwparker/orca/workspaces/orca/perf/src/renderer/src/components/x.ts'

describe('no-op regex passes stay skipped', () => {
  it('runs zero replaces for a path with no doubled slash, trailing slash, or backslash', () => {
    expect(
      countReplaceCalls(() => guarded.normalizeRuntimePathForComparison(CLEAN_POSIX_PATH))
    ).toBe(0)
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathSeparators(CLEAN_POSIX_PATH))).toBe(
      0
    )
    expect(countReplaceCalls(() => parseWslUncPath(CLEAN_POSIX_PATH))).toBe(0)
  })

  it('runs one replace per pass that is genuinely needed', () => {
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathForComparison('/a//b'))).toBe(1)
    expect(countReplaceCalls(() => guarded.normalizeRuntimePathForComparison('/a/b/'))).toBe(1)
  })
})

describe('a fan-out folds its root once, not once per candidate', () => {
  const root = '/Users/nwparker/orca/workspaces/orca/perf'
  const candidates = Array.from({ length: 50 }, (_, index) => `${root}/src/file-${index}.ts`)

  it('normalizes the root a single time across the whole batch', () => {
    // 1 root fold + 2 per candidate (comparison key, then the NFC Windows-ness probe).
    const calls = countNormalizeCalls(() => {
      const resolver = guarded.createRelativePathInsideRootResolver(root)
      for (const candidate of candidates) {
        resolver.resolve(candidate)
      }
    })
    expect(calls).toBe(1 + candidates.length * 2)
  })

  it('costs strictly more when the root is re-folded per candidate', () => {
    const perCall = countNormalizeCalls(() => {
      for (const candidate of candidates) {
        guarded.relativePathInsideRoot(root, candidate)
      }
    })
    expect(perCall).toBe(candidates.length * 3)
  })
})
