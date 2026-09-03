# WSL resident relay and foreground identity plan

Status: implemented in the resident WSL relay; real-WSL hardware validation is
outstanding as a separate follow-up.

## Decision and outcome

Turn the current hooks relay into a multi-capability relay: one long-lived,
versioned Node process in every resolvable WSL distro and Orca instance. Its
existing hook receiver and home-scoped filesystem bridge remain capabilities of
the relay, while process/identity reads become a third capability and future
in-distro work can be added behind the same negotiated protocol.

The Windows side uses `wsl.exe` only to discover, ensure, and launch the agent.
Once the stdio channel is ready, hook, filesystem, and process work use framed
JSON-RPC over that channel. In particular, a foreground-process observation
does not start a new `wsl.exe` process. Idle means zero identity work: no
process snapshot, identity RPC, or per-event `wsl.exe` invocation. A live
transport's already-existing framing keepalive is control-plane maintenance,
not an identity poll.

The relay name is deliberately not hooks-specific:

- Product/process name: **Orca WSL relay**.
- Entry point: `src/relay/wsl-agent-hook-relay.ts` (compatibility bundle name).
- Host owner: `WslHookRelayManager` (with lifecycle, launch, link, recovery,
  and contract modules split by responsibility).
- Guest install root: `.orca-wsl/hook-relay/<bundle-version>/`.

The existing endpoint directory under `.orca-wsl/agent-hooks/` remains a
compatibility path while managed hook writers migrate. The process and bundle
retain relay naming in user-facing text, telemetry, and APIs.

No user command is changed. There is no shim, required launch flag, or
user-visible wrapper. The agent is an Orca-owned helper launched beside the
WSL PTY, not a replacement for the user's shell or agent command.

## Boundaries and scope

### Relay capabilities

The relay owns work whose truth or filesystem is inside the distro:

1. The loopback hook receiver, including the existing token, endpoint-file
   publication, replay behavior, and fail-open hook HTTP handling.
2. The home-scoped filesystem bridge used by managed hook and plugin
   installers. Path containment, errno mapping, and the existing SFTP-shaped
   methods stay in the guest boundary; there is no general arbitrary-exec RPC.
3. A process/identity capability that reads one coherent guest observation:
   distro boot id, process table, `/proc` start ticks, tty, process groups, and
   command lines, then resolves requested PTY anchors.
4. Health and capability negotiation, including the bundle/protocol version,
   readiness, request deadlines, and bounded response sizes.
5. Future in-guest capabilities such as a structured environment probe or
   guest-local metadata read, each as an explicitly named, versioned method.
   A future capability must not smuggle a per-operation `wsl.exe` path back
   into a caller.

The relay never owns Windows settings, Orca's pane/status model,
the WSL distro catalog, or renderer policy. It cannot decide that a process is
gone merely because its own connection disappeared.

### Host capabilities

The Windows host owns:

- the WSL distro catalog and capability policy;
- deciding which distro/instance needs an agent and ensuring it;
- bundle selection, extraction, locks, protocol negotiation, retries,
  telemetry, and user-facing diagnostics;
- associating a WSL PTY with its guest shell anchor and current PTY
  incarnation;
- applying the guest's structured identity result to pane status, completion,
  and publication; and
- the fallback policy when the agent cannot be reached.

The host remains authoritative for a Windows-native PTY. The guest is not a
general execution host for arbitrary Orca operations: commands, shell input,
and PTY lifecycle still run through the normal WSL PTY path.

### Cross-platform boundary

This is a WSL-specific adapter, enabled only on Windows when a PTY has a WSL
distro context. Native Windows panes continue to use the native process-table
and ConPTY/job evidence. macOS and Linux panes continue to use their native
POSIX providers and do not install a WSL relay. SSH panes use the execution
host's SSH relay/provider; a local Windows WSL agent must never inspect or stand
in for an SSH host. A Windows machine reached over SSH is not thereby a WSL
target and remains subject to that SSH provider's measured identity support.
Folder workspaces follow the same execution-host rule and do not become git
worktree assumptions.

## Ensure and lifecycle

### Ensure state machine

`ensure(distro, reason)` is called from WSL PTY creation/reattach and from an
identity request that has a live WSL pane. It is not called by a periodic
identity timer. The manager key is the normalized distro plus the stable
Orca-instance key, so case variants of a distro coalesce but two Orca
instances have independent control channels and endpoint identities.

Each manager key has one in-memory `ensure` promise. Every caller joins that
promise; a failed attempt leaves a bounded backoff state rather than starting a
second launch. The guest filesystem has a second, cross-process install lock so
two Orca instances (or an app restart racing the old process) cannot extract
over one another. The lock is an atomic directory or equivalent, records the
guest PID and owner nonce, detects a dead owner, and has a bounded wait. A
partial tree is never published as usable.

The serialized ensure sequence is:

1. Check Windows, WSL availability, and a resolvable non-empty distro. For
   recovery, query `wsl --list --running` first; this
   check must not boot a stopped distro.
2. Resolve the packaged agent bundle and its semantic protocol version. Build
   an instance-specific environment through `WSLENV`; do not put a script or
   secret in a user command's argv.
3. Run a short, machine-readable preflight through
   `wsl.exe -d <distro> --exec sh -s`. It probes `HOME`, the version marker,
   the installed tree, and a usable Node (18 or newer), and reports a fenced
   result. `--exec` is mandatory; never use the bare `--` form. A captured
   login-shell command uses the existing nonce fence so banners cannot be
   mistaken for the result.
4. If the exact version-keyed tree is absent or incomplete, acquire the guest
   install lock and stream an idempotent extraction script through
   `wsl.exe --exec sh -s`. Write bundle/launcher files to PID-unique temporary
   names, verify their bytes, atomically rename them, and write the version
   marker last. Release the lock only after a complete tree is visible. An
   existing complete tree is reused without extraction.
5. Spawn the long-lived agent with the existing WSL interop boundary (an
   explicit `wsl.exe --exec sh ...` launch, not a user-shell command), wait for
   its exact readiness sentinel, and perform a protocol/capability handshake
   before sending requests. The preflight/extraction lane is the only `sh -s`
   data crossing; process, hook, fs, and health operations use the open stdio
   channel.
6. Ask for the guest home/endpoint coordinates, then publish the endpoint and
   mark the state `running`. Hook installation and plugin overlay work are
   follow-on operations and must not block the agent's health/identity method
   indefinitely.

The manager keeps the current recovery properties: startup failures use a
bounded exponential cooldown; a missing Node has a long cooldown; a stable run
resets the failure count; and a dead running link receives a bounded restart
attempt. A request deadline or a dead transport cancels in-flight work before
the child is replaced. No recovery timer may boot a distro that is not listed
as running.

### Deliberate death and app lifecycle

The relay dies when its stdin closes, as the current relay deliberately
does. A lingering guest listener could let WSL's Windows-to-WSL forwarding
path claim a freed host port and blackhole stale hook posts; a grace period or
detached daemon would make that failure silent. The agent also exits on stdout
error, SIGTERM/SIGINT, an unrecoverable protocol error, or an uncaught
exception. The host closes the mux and kills the child on every teardown.

On a normal app restart, the old manager closes stdin/child, and the new manager
reuses the restart-stable instance key but obtains fresh hook coordinates. The
new agent rewrites the same guest endpoint file with the fresh port/token;
surviving hook clients therefore re-coordinate without a stale path. An
instance generation/owner nonce in the endpoint and handshake prevents an old
agent from being accepted after a replacement. If an old child survives an
unclean app crash, the new handshake treats it as a competing owner, closes it
when possible, and never sends identity requests to an unnegotiated process.

When a distro is stopped, restarted, or terminated by `wsl --shutdown`, the
stdio child and mux are expected to close. The manager records the link as
failed/unavailable, clears request state, and waits for a later WSL PTY spawn or
explicit user action. Recovery must not invoke `wsl -d` merely to resurrect a
distro the user shut down. A restart of the distro gives a new boot id; all
old guest shell anchors and observations are consequently invalid and require
a fresh shell marker and a fresh agent request.

When the user removes a distro, the next list/preflight failure drops only that
distro's state, endpoint metadata, timers, and cached observations. It does not
try another distro or repeatedly recreate the removed one. A newly created
distro is a new identity and goes through ensure and fresh anchors.

## Capability gating and hooks-off behavior

Relay residency is gated only by Windows (`process.platform === 'win32'`) and
a resolvable, non-empty WSL distro. Ensure is not gated on
`remoteHooksEnabled`, `agentStatusHooksEnabled`, managed hook settings, or the
list of enabled integrations. The relay is deployed/ensured in every distro;
there is no consent state, one-time dialog, or unknown tri-state.

The hook capability alone respects `agentStatusHooksEnabled !== false` and the
remote hooks setting. When either setting opts out, the relay remains present
for health, home-scoped fs, and process/identity reads, but its hook capability
is inert: no hook configuration is installed or refreshed, no hook posts are
published, and no hook events are wired. Re-enabling hooks resumes the existing
idempotent installer path.

The foreground-process/identity capability is always active regardless of hook
settings. If the relay is unavailable, identity is `unverifiable`; title may
still be shown as the absolute last display fallback but cannot become process
evidence. Residency changes are not inferred from a missing distro or failed
request.

## Protocol, versioning, and mixed versions

The relay has a small handshake before normal JSON-RPC:

```text
client -> hello { protocolMajor, protocolMinor, bundleVersion, instanceKey,
                  requestedCapabilities }
agent  -> ready { protocolMajor, protocolMinor, bundleVersion,
                  agreedMinor, capabilities, agentGeneration }
```

The semantic protocol version governs compatibility; the bundle version also
identifies the exact shipped tree. A major mismatch is refused explicitly.
Additive methods/optional fields use a negotiated minor capability. The host
never sends a method merely because JSON-RPC would technically carry it: it
first checks the agent's advertised capability. Unknown methods and malformed
responses become visible, bounded errors rather than an apparent empty result.

The guest launcher compares the expected bundle version with the version
marker. A missing marker, incomplete tree, or mismatch exits with a distinct
stale-agent result. The host then performs exactly one serialized ensure and
relaunch for that generation. Extraction is version-keyed, atomic, and
content-complete; old version directories are retained while an instance has a
live process and garbage-collected only after no endpoint/owner references
remain. Never overwrite a running version directory in place.

Mixed versions are normal:

- An older relay may continue to serve the existing hook/fs methods to an
  older Orca instance. A newer host that negotiates with it but sees no
  `process.identity` capability keeps hooks/fs compatibility and marks WSL
  identity `unverifiable`; it does not silently use a bare name or spawn
  `wsl.exe` per event.
- A newer relay retains the old method names and response members needed
  by old clients. New identity fields are optional and are not made required
  for hook/fs callers.
- A major protocol mismatch or a stale exact bundle is a detectable replacement
  path, not a stale server used optimistically. A minor mismatch selects the
  agreed capability subset.
- Two Orca instances share the immutable versioned tree but have distinct
  instance keys, endpoint files, owner nonces, and stdio children. One cannot
  answer the other's PTY requests or overwrite its endpoint.

The wire review must follow `docs/reference/remote-wire-compatibility.md`:
optional fields are safe only while old readers can ignore them, and changing
host-published content is a wire change even without a codec change. Add a
cross-version agent harness for old/new client combinations and assert that a
new client degrades safely when the identity capability is absent.

## Routing WSL foreground identity through the agent

### Request shape and ownership

Reuse the pure resolver and anchor model from PR #17757, but move its transport
from the host's per-burst `wsl.exe --exec ps` reader to an agent method. The
host-side manager exposes a request such as `process.identity.read` with a
batch of pane anchors for one distro. The agent captures one complete process
observation and resolves every anchor in that batch, returning one structured
record per request. A request carries the host's PTY id/incarnation for
correlation, but the guest's proof is the guest anchor and process data.

Route all WSL foreground reads through this adapter:

- `getForegroundProcess`/`getForegroundProcessName` uses the agent method;
- `inspectProcess` and completion confirmation consume the same structured
  result;
- process/session listing may request the same batch projection; and
- no caller reaches the old host `runWslGuestProcessInventory` command runner
  after migration.

The agent's capture is single-flight per distro with a short bounded freshness
window (the current 500 ms event-burst window is a suitable starting point).
It reads `/proc` start ticks in the same capture and resolves all panes in O(N)
after the snapshot. It does not maintain a background process poll.

### Fences (unchanged from PR #17757)

The identity contract must preserve every existing fence, with no weakening or
new synonym:

1. **Distro** — the requested distro and anchor distro must match.
2. **Boot id** — `/proc/sys/kernel/random/boot_id` must match the anchor. A
   distro restart invalidates all prior observations.
3. **Guest shell PID** — the anchored shell PID must be present in the same
   complete guest capture.
4. **`/proc` start ticks** — the shell's `/proc/<pid>/stat` start-time ticks
   must match, preventing PID reuse; a selected candidate's own start ticks
   must come from that same capture.
5. **TTY** — the shell and candidate must use the same normalized controlling
   tty.
6. **Foreground process group** — correlate the shell's terminal foreground
   group (`tpgid`/`pgid`) and the rows in that group; the `stat` foreground
   marker is not a substitute for the group relationship.
7. **Multiplexer boundary** — reject `tmux`, `screen`, or an equivalent
   descendant/session crossing to another tty. Do not guess through a
   multiplexer without a future session-aware anchor.
8. **Ambiguity/completeness** — a partial capture, missing required field, or
   more than one recognized agent in the foreground group is not a name.
   Return an explicit unverifiable reason.

The agent may return `live` with `processName: null` when all fences prove a
foreground shell or other unrecognized command. It returns `unverifiable` for
missing anchors, stale boot/start ticks, tty/group mismatch, multiplexer
boundaries, ambiguity, malformed/partial capture, unsupported capability,
timeout, or lost contact. `exited` is reserved for positive evidence from the
owning host/agent tied to the exact authority, PTY id, and incarnation; it is
not produced by an absent map entry, a missing response, a closed socket, a
stopped distro, or an anchor that could not be checked. The only verdict
vocabulary is **`live` / `unverifiable` / `exited`**.

The host must reject a late response when its PTY id, incarnation, distro,
agent generation, or request epoch no longer matches the pane. It must not
turn a transport error into `exited`. Existing launch/hook identity evidence
can continue to participate in pane identity resolution, but a guest process
name is accepted only from a validated `live` record. Title parsing is the
absolute LAST identity fallback (and remains a display fallback); it never
repairs a failed fence or upgrades `unverifiable` to `live`.

Title is the absolute LAST identity fallback.

### Agent health versus process death

An agent request has a deadline and cancellation path. If the agent wedges,
the host marks the request `unverifiable`, disposes the mux, kills the child,
and schedules a bounded ensure only when the distro is still running. A
foreground identity result cannot claim that the shell or agent exited merely
because the agent failed. A future explicit guest retirement/tombstone method
may produce `exited`, but it must carry the same boot/authority/incarnation
fences and be tested as positive evidence.

## Cost invariant and measurement

The current PR #17757 rule is at most one host `ps` capture per distro per event
burst, shared by its panes through a 500 ms cache. Replace the _transport_, not
the bounded work: one qualifying burst becomes at most one `process.identity.read`
RPC per distro, one guest process snapshot, and O(number of anchors) local
resolution. Concurrent bursts join the in-flight request; different distros
remain isolated. There is no per-pane `wsl.exe`, no per-process `cat`, and no
active-agent interval poll.

Qualifying events are spawn/attach/reattach/reconnect when an anchor or identity
expectation exists, an OSC command boundary that needs confirmation, visible or
focused inspection, an explicit completion check, or a hook/launch event that
starts a finite settle ladder. Repeated output alone does not start a loop.
The finite ladder is cancelled on success, rebind, disposal, expiry, or agent
shutdown. Automatic idle/session-list refreshes request inventory metadata
without `process.identity.read`.

Instrument both sides with counters and bounded timings:

- host: ensure calls, identity RPCs, joined/coalesced requests, deadline and
  transport failures, bytes, and per-distro request latency;
- guest: snapshots, rows scanned, snapshot age, resolver count, and rejected
  anchors; and
- boundary: `wsl.exe` process creations attributable to ensure/preflight versus
  identity operations.

Acceptance tests must prove that a long simulated idle with many WSL panes
produces exactly zero identity RPCs, relay snapshots, and identity `wsl.exe`
spawns; one burst produces one in-flight request/snapshot per distro; N panes
do not produce N snapshots; and a wedge/backoff does not spin. A real-WSL
benchmark should report the same counters and p50/p95 request latency without
recording command text or process arguments.

## Migration from PR #17757

The work layers on PR #17757 for dependency order, then supersedes its host
transport:

1. Land the existing anchor emission, parser, resolver, and fence tests from
   #17757 (including distro, boot id, guest shell PID, `/proc` start ticks, tty,
   foreground group, multiplexer, and ambiguity cases). This establishes
   correct identity semantics while the adapter is built.
2. Add the general relay, ungated ensure lifecycle, capability handshake, and
   `process.identity.read`. Move the #17757 pure resolver into the relay
   bundle or a shared relay-safe module and compare relay results with its
   existing fixtures.
3. Switch WSL foreground reads, inspect, completion, and listing to the agent
   adapter. During a staged rollout, an internal diagnostic can count what the
   old reader would have done, but it must not be a user-visible fallback or
   source of identity.
4. Delete the production `wsl.exe --exec ps` per-operation path and its
   per-event inventory runner once parity and real-WSL evidence pass. Keep
   `wsl.exe` for agent preflight, versioned extraction, launch, and recovery;
   those are the bootstrap boundary, not the data path.

Thus #17757 is neither discarded nor left as a permanent fallback: its fences
and resolver are retained, while its expensive host invocation is replaced.
If the agent is unavailable, disabled, stale, or lacks the capability, WSL
identity is `unverifiable` and the title remains only the last display fallback.
No user command changes during any phase.

## Failure modes and required behavior

| Condition                                       | Agent/manager behavior                                                                                                                                                 | Identity/status behavior                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Agent fails to start or bundle extraction fails | Record a bounded failure/cooldown; show an actionable diagnostic; retry only on an eligible event or running-distro recovery.                                          | `unverifiable`; never use a bare name or per-event `wsl.exe` fallback. |
| Guest has no Node >= 18                         | Return a distinct no-Node diagnostic; do not install Node or modify the user's shell/commands; use a long cooldown.                                                    | `unverifiable`; hooks/fs/identity stay degraded for that distro.       |
| Agent wedges or misses a deadline               | Cancel the request, dispose the link, kill/replace the child after bounded recovery, and preserve the pane's prior evidence without inventing an exit.                 | `unverifiable`; contact loss is never `exited`.                        |
| Distro stops during a request                   | Fail the request and link; do not boot it from recovery; wait for a later WSL activity.                                                                                | `unverifiable`; a new boot requires a new anchor.                      |
| `wsl --shutdown`                                | Mark every affected distro link unavailable and cancel requests; do not restart until a running PTY/explicit action warrants it.                                       | `unverifiable` until a fresh agent and fences answer.                  |
| Two Orca instances use one distro               | Share only immutable versioned installation under the guest install lock; keep separate instance keys, endpoint files, owner nonces, children, and request namespaces. | Each pane accepts only its own agent generation/incarnation.           |
| Distro was removed                              | Drop only its state/cache/timers and stop retrying; do not map the request to another distro.                                                                          | Existing panes become `unverifiable`; no identity is synthesized.      |
| Hooks are disabled                              | Keep the relay for identity/fs/health; skip managed hook install/refresh and discard hook notifications at the host.                                                   | Identity still works from fenced relay reads.                          |
| Old guest version or missing capability         | Negotiate compatible hook/fs subset or replace the stale bundle; never silently send unsupported identity methods.                                                     | `unverifiable` when `process.identity` is unavailable.                 |

## Module split and verification plan

Do not grow another monolithic relay file and do not add a max-lines disable or
per-file bump. Split concrete responsibilities, for example:

- `src/relay/wsl-agent-hook-relay.ts` — process bootstrap, stdio lifetime, and
  readiness;
- `src/shared/wsl-hook-relay-contract.ts` — handshake, capabilities, and
  method names/types;
- `src/relay/wsl-relay-process.ts` — `/proc` capture and pure fenced
  resolver;
- `src/relay/wsl-agent-hook-relay.ts` and
  `src/relay/wsl-hook-fs-bridge.ts` — existing hook and fs adapters;
- `src/main/agent-hooks/wsl-hook-relay-manager.ts` — per-distro state and
  capability gates;
- `src/main/agent-hooks/wsl-hook-relay-launch.ts` — preflight, lock,
  extraction, and version selection;
- `src/main/agent-hooks/wsl-hook-relay-link.ts` — mux requests and death;
  and
- `src/shared/wsl-hook-relay-contract.ts` — path, env, protocol, and
  capability constants, with a temporary compatibility re-export for old hook
  contract imports.

Required tests include:

- `/bin/sh` syntax, `--exec` argv, capture fencing, atomic extraction,
  concurrent ensure/lock ownership, stale/partial version trees, app restart,
  no Node, distro shutdown/removal, and two-instance isolation;
- protocol negotiation in both skew directions, unknown capability handling,
  stale replacement, and old hook/fs method compatibility;
- every PR #17757 fence and ambiguity case through the agent request, plus
  late-response PTY incarnation rejection and the exact verdict vocabulary;
- hooks-on versus hooks-off capability tests, and no hook mutation or event
  publication while opted out;
- cost tests proving zero idle work, one snapshot/RPC per distro burst,
  coalescing, bounded retries, and no process-table work for metadata-only
  listing; and
- platform routing tests proving native Windows, macOS/Linux, SSH, and folder
  workspaces never accidentally use the WSL agent.

Real-WSL validation should use a disposable distro and ordinary user commands:
start agents by typing their normal command, cross a shell command boundary,
exercise a multiplexer, restart the distro, close/reopen Orca, and run two
instances. Compare identity and timing counters, verify that stale/ambiguous
cases stay `unverifiable`, and confirm that only positive host/agent evidence
can produce `exited`.
