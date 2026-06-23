// Deterministic environment / session tinting (see docs "Dynamic Terminal Color Spec").
//
// An environment gets a base hue — from a user-picked palette color, or hashed from its
// name when none is picked. Each session in that environment shifts the hue by its ordinal
// (×15°). Saturation/lightness are clamped per system theme so text stays legible.
import type { Environment, Session } from "../../protocol";

export interface Swatch {
  name: string;
  hex: string;
}

// The 16-color palette: the wheel split into even 22.5° intervals. The hex anchors the hue;
// saturation/lightness are recomputed at render time per theme.
export const PALETTE: Swatch[] = [
  { name: "Burgundy", hex: "#993333" },
  { name: "Cognac", hex: "#995933" },
  { name: "Ochre", hex: "#998033" },
  { name: "Olive", hex: "#809933" },
  { name: "Ivy", hex: "#599933" },
  { name: "Hunter", hex: "#339933" },
  { name: "Spruce", hex: "#339959" },
  { name: "Teal", hex: "#339980" },
  { name: "Slate", hex: "#338099" },
  { name: "Oxford Blue", hex: "#335999" },
  { name: "Navy", hex: "#333399" },
  { name: "Indigo", hex: "#593399" },
  { name: "Eggplant", hex: "#803399" },
  { name: "Plum", hex: "#993399" },
  { name: "Mauve", hex: "#993380" },
  { name: "Rosewood", hex: "#993359" },
];

export type Theme = "light" | "dark";

// ── HSL ↔ RGB hex ────────────────────────────────────────────────────────────
/** Hue 0–360 from a "#rrggbb" hex. Returns 0 for greys / unparseable input. */
export function hueFromHex(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return 0;
  const r = parseInt(m[1]!, 16) / 255;
  const g = parseInt(m[2]!, 16) / 255;
  const b = parseInt(m[3]!, 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return ((h % 360) + 360) % 360;
}

/** HSL (h 0–360, s/l 0–1) → "#rrggbb". */
export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to2 = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

// FNV-1a string hash → stable across reloads, used for the hue fallback.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The environment's base hue: from its picked color, else hashed from its name (then id). */
export function baseHue(env: Environment | undefined): number {
  if (env?.color) return hueFromHex(env.color);
  const seed = env?.name?.trim() || env?.id || "";
  return hashString(seed) % 360;
}

// ── Session backgrounds ──────────────────────────────────────────────────────
// Saturation kept low (avoids clashing with syntax highlighting); lightness clamped to a
// readable band per theme. Stripe is a touch more saturated/contrasty for the sidebar accent.
const BG_SAT = 0.25;
const BG_LIGHT_L = 0.9; // light theme: pale bg, dark text
const BG_DARK_L = 0.11; // dark theme: deep bg, light text
const STRIPE_SAT = 0.55;
const STRIPE_LIGHT_L = 0.5;
const STRIPE_DARK_L = 0.6;

function sessionHue(env: Environment | undefined, ordinal: number): number {
  return (baseHue(env) + ordinal * 15) % 360;
}

/** The derived background for a session, clamped for legibility under `theme`. */
export function sessionBg(env: Environment | undefined, ordinal: number, theme: Theme): string {
  const l = theme === "dark" ? BG_DARK_L : BG_LIGHT_L;
  return hslToHex(sessionHue(env, ordinal), BG_SAT, l);
}

/** A stronger accent of the same hue, for the sidebar row stripe. */
export function stripeColor(env: Environment | undefined, ordinal: number, theme: Theme): string {
  const l = theme === "dark" ? STRIPE_DARK_L : STRIPE_LIGHT_L;
  return hslToHex(sessionHue(env, ordinal), STRIPE_SAT, l);
}

/**
 * The session's ordinal within its environment: index among that env's sessions ordered by
 * createdAt (stable). Sessions without an environment get 0. `all` is the live session map.
 */
export function envOrdinal(session: Session, all: Iterable<Session>): number {
  if (!session.environmentId) return 0;
  const peers = [...all]
    .filter((s) => s.environmentId === session.environmentId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const idx = peers.findIndex((s) => s.id === session.id);
  return idx < 0 ? 0 : idx;
}
