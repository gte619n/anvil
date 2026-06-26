// Generates the light/dark README banners by embedding the anvil mark
// (anvil-mark.svg) next to an adaptive wordmark + tagline.
// Run:  bun docs/assets/gen-banner.ts
import { readFileSync, writeFileSync } from "node:fs";

const markSvg = readFileSync(new URL("./anvil-mark.svg", import.meta.url), "utf8");
// Pull the inner drawing (everything inside the <svg>…</svg> wrapper).
const inner = markSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

// Anvil mark native viewBox is 696×693. Scale it down and seat it on the left.
const MARK = 132;
const scale = MARK / 696;
const markY = (200 - MARK) / 2; // vertically centered in a 200-tall banner

function banner({ word, tagline }: { word: string; tagline: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="200" viewBox="0 0 760 200" fill="none" role="img" aria-label="Anvil">
  <g transform="translate(28 ${markY}) scale(${scale.toFixed(4)})">
${inner}
  </g>
  <text x="196" y="96" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="78" font-weight="800" letter-spacing="-2" fill="${word}">Anvil</text>
  <text x="200" y="138" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="23" font-weight="500" fill="${tagline}">Drive Claude Code from anywhere.</text>
</svg>
`;
}

// Light background → dark ink.  Dark background → light ink.
writeFileSync(new URL("./anvil-banner-light.svg", import.meta.url),
  banner({ word: "#1F2328", tagline: "#59636E" }));
writeFileSync(new URL("./anvil-banner-dark.svg", import.meta.url),
  banner({ word: "#F0F6FC", tagline: "#9198A1" }));

console.log("wrote anvil-banner-light.svg + anvil-banner-dark.svg");
