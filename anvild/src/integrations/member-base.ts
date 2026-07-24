/** A member's worktree branches off the lead's branch HEAD (consistent start). existing-dir needs no base. */
export function memberBaseRef(a: { source: "fresh-worktree" | "existing-dir"; leadBranch?: string; envDefault?: string }): string | undefined {
  if (a.source === "existing-dir") return undefined;
  return a.leadBranch ?? a.envDefault ?? "HEAD";
}
