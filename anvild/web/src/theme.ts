// ── Theme (light / dark / system, chosen in Settings → Appearance) ────────────
// Pure theme resolution: read the stored preference, resolve it (consulting the OS for "system"),
// and report/mark the painted theme. The repaint side (applyTheme/setThemePref, which re-render the
// session list) stays in main.ts so this module has no back-references into the app — keeping it a
// load-order-safe leaf.
export type ThemePref = "light" | "dark" | "system";

/** The user's stored preference; absence (or anything unexpected) means "follow the OS". */
export function themePref(): ThemePref {
  const s = localStorage.getItem("anvil.theme");
  return s === "light" || s === "dark" ? s : "system";
}
/** The concrete theme currently painted on <html>. */
export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
/** Resolve a preference to a concrete theme, consulting the OS for "system". */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return pref;
}
/** Mark the active swatch in Settings → Appearance (no-op when Settings isn't open). */
export function updateThemeControls(): void {
  const pref = themePref();
  document.querySelectorAll<HTMLElement>(".theme-opt").forEach((b) => b.classList.toggle("active", b.dataset.themePref === pref));
}
