/** Branch-slug for session/member titles — lowercase, dash-separated, ≤32 chars, never empty.
 *  Shared by the Supervisor's session-create/pipeline branch naming and the TeamCoordinator's
 *  member-title collision check (P7: moved out of supervisor.ts so both can import it). */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "session"
  );
}
