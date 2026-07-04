# Security

## Trust model

Anvil's security boundary is **Tailscale + its ACLs**. The `anvild` daemon exposes its HTTP/WebSocket
API on a tailnet address and is **unauthenticated by design** — every device and user that can reach
the daemon over the tailnet is trusted at the network layer. This is a deliberate architectural
decision, not a gap.

**The one hard requirement:** the daemon must **never** be exposed off-tailnet. Do not bind it to a
public interface, port-forward it, or place it behind a reverse proxy that terminates outside the
tailnet. Restrict access with Tailscale ACLs so only the intended devices/users can reach it. If you
need to narrow access further, use tailnet ACLs — not an app-layer password.

Because there is no app-layer auth, anyone who can route to `host:7701` can drive the full API
(create/reset sessions, read worktree files, answer permission prompts, trigger a self-update).
That is acceptable **only** under the tailnet boundary above.

## What the daemon still defends against (independent of the network boundary)

Even with a trusted tailnet, these controls exist because they protect against threats the network
perimeter can't:

- **Autonomous agent code-execution.** The unattended dev pipeline runs a third-party model (GLM)
  with Write/Edit/Bash. Every tool call is gated through a danger list that **hard-denies**
  destructive commands, writes escaping the session worktree, and credential/secret paths
  (`src/agent/pipeline-guard.ts`, `src/agent/danger-list.ts`).
- **`git clone` argument injection.** Clone URLs are allowlisted to `https://` / `ssh://` / scp-form
  and the `ext::` remote-helper transport is disabled, so a crafted URL can't run a shell command
  (`src/git/ops.ts` `assertSafeCloneUrl`).
- **Cross-site WebSocket hijack.** The `/ws` upgrade checks the browser `Origin` and rejects foreign
  origins, so a malicious website loaded in a *trusted device's* browser can't drive the daemon
  (`src/server/origin.ts`). Native clients and the same-origin PWA are allowlisted; set
  `ANVIL_ALLOWED_ORIGINS` (comma-separated) to permit additional first-party origins.
- **Path containment.** Attachment and worktree file access is confined to the session directory;
  client-supplied filenames/ids can't traverse out (`src/attach/store.ts`, `src/fs/session-fs.ts`).
- **Local file permissions.** Files holding secrets (env file, push registries, VAPID key) are
  written `0600`.
- **Content XSS.** Rendered markdown is sanitized server-side with DOMPurify after
  shiki/KaTeX/mermaid, with `markdown-it html:false` and KaTeX `trust:false`.

## Secrets

- The Anthropic subscription token, OpenRouter key, and Todoist token live in `~/.config/anvil/env`
  (and per-store files) at `0600`; they are never logged or returned to clients (only masked
  previews are surfaced).
- The daemon refuses to start if `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are set in its
  environment, so a metered key can't leak into agent subprocesses.

## Reporting a vulnerability

Email **evan.ruff@oxos.com** with details and reproduction steps. Please do not open a public issue
for security-sensitive reports. Since Anvil is tailnet-scoped, include whether the issue is reachable
*within* the trust model (agent execution, browser origin, path traversal, content) versus assuming
off-tailnet exposure (out of scope by design).
