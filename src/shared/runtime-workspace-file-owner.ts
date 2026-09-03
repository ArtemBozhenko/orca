import type { ExecutionHostId } from './execution-host'
import { createRelativePathInsideRootResolver } from './cross-platform-path'

export type RuntimeWorkspaceFileRoot = {
  workspaceId: string
  rootPath: string
  executionHostId: ExecutionHostId
}

export type RuntimeWorkspaceFileOwner = RuntimeWorkspaceFileRoot & {
  relativePath: string
}

export function findRuntimeWorkspaceFileOwner(
  roots: readonly RuntimeWorkspaceFileRoot[],
  absolutePath: string,
  executionHostId: ExecutionHostId
): RuntimeWorkspaceFileOwner | null {
  let best: RuntimeWorkspaceFileOwner | null = null
  let bestRootLength = -1

  for (const root of roots) {
    if (root.executionHostId !== executionHostId) {
      continue
    }
    const insideRoot = createRelativePathInsideRootResolver(root.rootPath)
    const relativePath = insideRoot.resolve(absolutePath)
    if (relativePath === null) {
      continue
    }
    const rootLength = insideRoot.comparisonRoot.length
    if (
      rootLength > bestRootLength ||
      (rootLength === bestRootLength &&
        best !== null &&
        root.workspaceId.localeCompare(best.workspaceId) < 0)
    ) {
      best = { ...root, relativePath }
      bestRootLength = rootLength
    }
  }

  return best
}
