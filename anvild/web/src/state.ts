// ── Shared mutable UI state ───────────────────────────────────────────────────
// ES modules can't reassign an imported binding (`import { x }` is read-only), so scalars that are
// *reassigned* and read across more than one module live as fields on this single `ui` object. Code
// writes `ui.foo = …` / reads `ui.foo`. In-place containers (Maps/Sets/arrays) don't have this
// problem — they're mutated, never reassigned — so they're exported as plain `const`s from the
// module that owns them, not parked here.
//
// This module imports nothing from the rest of the app (protocol types only, erased at compile
// time): it's the leaf that other modules funnel shared state through, which keeps import cycles
// from forming (see the load-order notes in main.ts).
import type { AuthAccountsEvent } from "../../protocol";

export const ui = {
  // popstates from our own dismissOverlay() unwind — the teardown already ran, so the matching
  // popstate is swallowed. Written by overlays.dismissOverlay, read/decremented by the popstate
  // handler in main.ts.
  suppressPop: 0,
  // Whether the session sidebar is collapsed. Owned by layout.ts, but the conversation core also
  // sets it (selecting a session collapses the sidebar on a phone). Seeded at boot in main.ts.
  sidebarCollapsed: false,
  // Set while a daemon self-update restart is in flight: the WS drops then reconnects, and that
  // reconnect is our signal the new build is live — reload to pick up the rebuilt web bundle.
  // Written by fleet.ts (wireDaemonUpdate), read/cleared by main.ts's onStatus reconnect handler.
  pendingRestartReload: false,
  // Conversation scroll lock: only auto-follow new content when the user is already at the bottom.
  // Owned by conversation.ts (scrollDown / the pane's scroll listener), but main's selectSession
  // also re-pins it — a freshly opened session starts pinned to the latest.
  stickToBottom: true,
  // The in-flight assistant streaming bubble (null when no draft is on screen). Owned by
  // conversation.ts (appendDelta / commitAssistant), but main's `result` handler nulls it and
  // setStatus reads it (while text streams, the text is the activity — no thinking indicator).
  streaming: null as HTMLElement | null,
  // Set when the user hits Stop: the daemon keeps draining the interrupted turn for a moment, so
  // main's handleSessionEvent suppresses that trailing churn. Written by conversation.ts
  // (cancelThinking / appendUser / clearConversation), read/cleared by main.ts. Cleared on the
  // next turn.
  turnCanceled: false,
  // True while a full-history snapshot is replaying: assistant links are added straight away (all
  // of Claude's past answers are relevant) and topic dividers keep normal flow. Written by main's
  // conversation.snapshot handler, read by conversation.ts (noteAnswerRefs / appendTopicDivider).
  replayingSnapshot: false,
  // The Claude account roster (Settings → Models; multi-account §9). Absent until the connect burst
  // or an explicit auth.accounts.get lands. Written by settings.ts (onAuthAccounts), read by main.ts
  // (the header account chip + switch menu, and the new-session/environment account pickers).
  claudeAccounts: undefined as AuthAccountsEvent | undefined,
  // Todoist link state (Settings → Integrations). Written by settings.ts (status / connect / project
  // load), read by main.ts (the environment modal's project picker + the event router's member
  // token-propagation check).
  todoistConnected: false,
  todoistProjectsLoaded: false,
  // The cid of a session.create we kicked off from the new-session dialog (dialogs.ts). The matching
  // session.created echoes this cid back to *us* only (other devices get it cid-less), so main's
  // event router can jump straight into the session we just made without also hijacking sessions
  // created elsewhere. Written by dialogs.ts (showNewSession), read/cleared by main.ts (onEvent).
  pendingCreateCid: null as string | null,
};
