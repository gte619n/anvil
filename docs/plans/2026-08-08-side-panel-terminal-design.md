# Side panel: pin + terminal overhaul — design

**Date:** 2026-08-08 · **Status:** draft · **Scope:** one PR

## Goal

Make the right-hand side panel usable for real work on desktop:

1. **Pin** the panel (desktop only) so clicking back into the conversation no longer dismisses
   it, with the conversation reflowing beside it (split view).
2. **Fix the terminal**: ^C actually interrupts the foreground process; selecting text is
   visible; copy and paste work (copy-on-select, right-click paste).
3. **Multiple terminals** per session, VS Code-style, with a kill/respawn escape hatch for
   wedged shells.

## Evidence (live debug, 2026-08-08)

Verified with a headed browser against both daemons (Linux hub `anvil`, macOS
`Davids-Mac-mini`):

- **^C**: the `\x03` byte reaches the PTY (line discipline echoes `^C`) but `sleep 100`
  survives. Root cause printed by bash on every open: `cannot set terminal process group:
  Inappropriate ioctl for device / no job control in this shell`. `Bun.spawn([shell],
  {terminal})` attaches the PTY as stdio but the shell is not a session leader with the PTY as
  controlling TTY, so SIGINT has no foreground process group to be delivered to. zsh on macOS
  fails identically but **silently** (no warning).
- **Selection**: xterm's selection model works (overlay divs get real geometry) but is
  invisible: `mountTerminal()` passes a theme with only `background`/`foreground`, and the
  effective `selectionBackground` resolves to white. The DOM renderer also paints selected
  glyph cells per-cell from `theme.selectionBackground`, so a CSS-only override colors only
  empty cells ("space selection") — the fix must go through the xterm theme.
- **Copy**: xterm keeps its selection internal (no DOM selection), so the browser's native
  copy never fires. `document.execCommand('copy')` returns false. A clipboard bridge must be
  wired explicitly.
- **Wedged terminals are permanent**: the per-session PTY + 256KB scrollback persist across
  panel open/close (good), but there is no UI to kill/respawn a stuck shell (bad).

## Constraints

- **Phone layout is untouched.** All pin/split CSS and the pin button are gated behind the
  existing desktop breakpoint (the same gating the pane resizers use). Verified by
  phone-viewport screenshots before/after (§ Testing).
- **Protocol changes are additive only.** Optional fields; no `PROTOCOL_VERSION` bump. Old
  clients (including the bundled native-app web UIs, which only ship on app release) keep
  working: they omit `termId` and get the default terminal, exactly today's behavior.
- The daemon fix must work for both login shells in the fleet (`bash` on Linux, `zsh` on
  macOS) → fix the PTY attach itself, not shell flags.
- Per-terminal scrollback stays capped at 256KB.

## Design decisions (from interview)

| Decision | Choice |
|---|---|
| Pin layout | Split: conversation reflows beside the panel (same panel width as overlay); overlay + click-outside-dismiss behavior unchanged when unpinned |
| Pin scope | Desktop only; persists in localStorage; survives session switches (panel stays open, same tab, re-targets new session) and reloads |
| Multi-term UI | Slim horizontal chip strip above the terminal: `[1: zsh ×][2: bun ×][+]` |
| Copy | Copy-on-select + ⌘C / Ctrl+Shift+C; Ctrl+C **with** a selection copies, without one sends SIGINT |
| Paste | PuTTY-style right-click pastes; Shift+right-click = native browser menu; ⌘V / Ctrl+V keep working |

Rejected: shell-flag workarounds for ^C (`bash -i` does not acquire a controlling TTY);
protocol version bump (additive suffices); VS Code-style vertical terminal rail (too wide for
a ~460px panel); keeping N live xterm instances (one live instance + daemon scrollback replay
is simpler and cheaper).

## Architecture

### 1. Daemon: job control (`anvild/src/session/terminal-manager.ts`)

The spawned shell must be a **session leader with the PTY slave as its controlling TTY**
(`setsid()` + `TIOCSCTTY`), so the kernel line discipline can deliver SIGINT to the
foreground process group.

- **Spike first**: check whether the Bun version in the fleet exposes native support
  (`Bun.Terminal` is new; this may be a since-fixed bug or a spawn option). If a Bun upgrade
  or option fixes it, prefer that.
- **Fallback — wrapper command** in `defaultSpawnTerminal`:
  - Linux: `setsid --ctty -w $SHELL` (util-linux, present on the hub).
  - macOS: `script -q /dev/null $SHELL` (BSD script allocates the ctty properly).
  - If the wrapper binary is missing, fall back to today's plain spawn and log a warning —
    degraded (no job control) beats a broken terminal.
- The wrapper choice lives in a small pure function (platform → argv) so it is unit-testable
  without a PTY.

Acceptance: `sleep 100` + ^C returns the prompt immediately on **both** hosts; bash no longer
prints the job-control warning.

### 2. Protocol (`docs/plans/anvil-protocol.ts`, additive)

```ts
// client → server: terminal.open / terminal.input / terminal.resize / terminal.close
termId?: string;            // absent = "1", the default terminal (back-compat)

// server → client: terminal.data / terminal.exit
termId?: string;            // absent = "1"

// Session (roster for the chip strip; updated on open/exit)
terminals?: { id: string; title: string }[];   // title = shell basename, e.g. "zsh"
```

No new message types, no version bump. Contract tests gain assertions that the new fields are
optional (additive-or-bump policy, REQUIREMENTS §4).

### 3. Daemon: multi-terminal

`TerminalManager` keys records by `(sessionId, termId)` (nested map). `open` without a
`termId` targets `"1"`. New terminals get the next free integer id. Cap: **8 per session**
(`BadCommand` beyond that). `kill(sessionId, termId)` closes one; `killAll` reaps a session's
whole set on session kill (unchanged externally). Each terminal keeps its own 256KB
scrollback. On open/exit the supervisor refreshes the session's `terminals` roster and fans
out the session update (existing session-update path).

### 4. Web: terminal UX (`anvild/web/src/panel.ts`)

- **Theme**: add `selectionBackground` + `selectionInactiveBackground` to both themes
  (accent-tinted: light `rgba(59,110,245,.30)`, dark `rgba(107,155,255,.35)`).
- **Copy**: `onSelectionChange` (settled on mouseup) → `navigator.clipboard.writeText`.
  `attachCustomKeyEventHandler`: ⌘C / Ctrl+Shift+C copy; Ctrl+C with a non-empty selection
  copies (and clears the selection) instead of sending `\x03`.
- **Paste**: `contextmenu` on the terminal host → `preventDefault()` +
  `navigator.clipboard.readText()` → `terminal.input`; Shift+right-click bypasses to the
  native menu. Clipboard-permission denial → toast.
- **Chip strip**: rendered from `session.terminals` roster above the xterm host, inside the
  Terminal tab. One **live xterm instance at a time**: switching chips disposes and remounts
  against the chosen `termId` (daemon scrollback replay repaints instantly — same mechanism
  as reopening the panel today). `[+]` opens the next id; `[×]` on a chip sends
  `terminal.close` (kill + roster update); killing the active chip respawns fresh on next
  open — this is the unstick escape hatch. `main.ts`'s `terminal.data`/`terminal.exit` router
  filters on the active `termId`.

### 5. Web: pin + split (desktop only)

- Pin toggle button in the panel tab bar (next to ✕), hidden on phone.
- Pinned state: class on `<body>`; the conversation column gets `margin-right:
  var(--panel-w)` and the panel drops its shadow — visually a split, with **zero DOM
  restructuring** (the panel stays `position:absolute`; the resizer keeps updating
  `--panel-w`, so the split tracks drags for free).
- Pinned semantics: `openPanel` skips `openOverlay` (not a back-stack layer);
  `wirePanelOutsideDismiss` returns early; ✕ closes **and unpins**.
- Persistence: `localStorage["anvil.panelPin"] = {view}` (present = pinned). On boot
  (desktop only), restored after the first session selection. On session switch the panel
  stays open and re-runs `openPanel(view)` against the new session (files reset to root, the
  terminal mounts the new session's default terminal).

## Data flow (multi-terminal)

```
chip click / [+]
  └─ web: dispose xterm → mount → terminal.open {sessionId, termId, cols, rows}
       └─ daemon: TerminalManager.open → spawn (or replay scrollback) → roster → session update
            └─ web: renderStrip(session.terminals)
keystrokes → terminal.input {termId} → pty.write
pty output → terminal.data {termId} → web: drop unless termId === activeTermId
shell exit → terminal.exit {termId} → roster update → strip refresh (+ "exited" note if active)
[×] chip  → terminal.close {termId} → kill → roster update
```

## Error handling

| Failure | Behavior |
|---|---|
| Wrapper binary missing (setsid/script) | Plain spawn (today's behavior), daemon log warning |
| Terminal cap (8) exceeded | `BadCommand` → toast |
| `terminal.*` for a dead/unknown termId | Ignored daemon-side (existing try/catch pattern); open spawns fresh |
| Clipboard write fails (copy-on-select) | Silent; keyboard copy still offered — one toast on first failure |
| Clipboard read denied (paste) | Toast: "Allow clipboard access to paste" |
| Pinned view's session killed | Panel stays pinned; next session selection re-targets it |

## Testing

- **Unit (bun:test)**: TerminalManager multi-term lifecycle with injected `SpawnTerminal` —
  two terminals, routed input, per-term scrollback, kill one / others live, cap → BadCommand,
  roster contents, `killAll`. Wrapper-argv pure function per platform.
- **Contract**: `wire-shape.test.ts` additions — `termId` optional on all six messages,
  `Session.terminals` optional; version stays 4.
- **CI gates**: `typecheck`, `typecheck:web`, `build:web`, `bun test` all green.
- **Live acceptance (agent-browser, both hosts)**: ^C kills `sleep 100`; no job-control
  warning; selection visibly highlights glyphs; select → paste round-trip via right-click;
  two terminals with independent shells; kill wedged chip → fresh shell; pin → split reflow →
  survives session switch + reload.
- **Phone-layout proof**: 390×844 viewport screenshots of conversation + panel open,
  before/after branch — pixel-identical expectations: no pin button, overlay dismiss
  unchanged.

## Phase tracking

| Phase | Description | Status | Tested | Pushed |
|-------|-------------|--------|--------|--------|
| 1 | Daemon job-control fix (spike Bun native, else wrapper) | pending | no | no |
| 2 | Web: selection theme + copy/paste wiring | pending | no | no |
| 3 | Protocol `termId`/roster + TerminalManager multi-term | pending | no | no |
| 4 | Web: chip strip + kill/respawn | pending | no | no |
| 5 | Pin + split view (desktop-gated) | pending | no | no |
| 6 | Cross-host live acceptance + phone-layout proof | pending | no | no |
