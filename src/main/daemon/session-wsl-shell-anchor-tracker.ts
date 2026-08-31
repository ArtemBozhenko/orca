import {
  createShellStartupIdentityScanState,
  scanForShellStartupIdentity,
  type ShellStartupIdentityScanState
} from '../shell-startup-identity-scanner'
import type { WslShellProcessAnchor } from '../../shared/wsl-shell-process-anchor'

export class SessionWslShellAnchorTracker {
  private scanState: ShellStartupIdentityScanState | null
  private _anchor: WslShellProcessAnchor | null = null

  constructor(private readonly distro: string | null) {
    this.scanState = distro ? createShellStartupIdentityScanState() : null
  }

  get anchor(): WslShellProcessAnchor | null {
    return this._anchor
  }

  scan(data: string): string {
    if (!this.scanState) {
      return data
    }
    const scanned = scanForShellStartupIdentity(this.scanState, data)
    if (scanned.shellIdentity) {
      if (scanned.shellIdentity.distro.toLowerCase() === this.distro?.toLowerCase()) {
        this._anchor = scanned.shellIdentity
      }
      this.scanState = null
    } else if (scanned.shellPid) {
      // Legacy PID-only markers are consumed but never accepted as evidence.
      this.scanState = null
    }
    return scanned.output
  }
}
