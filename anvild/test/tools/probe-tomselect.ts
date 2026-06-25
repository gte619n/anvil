/** Probe: Tom Select instantiates with the app's settings and renders data-icon/data-color into
 *  each option, with search disabled via controlInput:null. Mirrors web/src/main.ts's enhanceSelect.
 *  Run: bun run test/tools/probe-tomselect.ts */
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
    <select id="env">
      <option value="a" data-icon="rocket_launch" data-color="#993333">Alpha</option>
      <option value="b" data-icon="folder" data-color="#335999">Beta</option>
    </select>
  </body></html>`,
  { pretendToBeVisual: true },
);
const { window } = dom;
// Tom Select reaches for these globals at module/instance scope.
for (const k of ["window", "document", "navigator", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
  // @ts-expect-error — wiring jsdom globals onto the bun runtime for the duration of the probe
  globalThis[k] = window[k] ?? globalThis[k];
}

const { default: TomSelect } = await import("tom-select");

const renderTomOption = (data: { [k: string]: unknown }, escape: (s: string) => string): string => {
  const ic = data.icon ? `<span class="msym ts-ic">${escape(String(data.icon))}</span>` : "";
  const dot = data.color ? `<span class="ts-dot" style="background:${escape(String(data.color))}"></span>` : "";
  return `<div class="ts-opt">${ic}${dot}<span class="ts-lbl">${escape(String(data.text ?? ""))}</span></div>`;
};

const sel = window.document.getElementById("env") as unknown as HTMLSelectElement;
const base = { maxOptions: null, hideSelected: false, render: { option: renderTomOption, item: renderTomOption } };
const ts = new TomSelect(sel, { ...base, controlInput: null });

const fail = (m: string): never => {
  console.error("❌", m);
  process.exit(1);
};

// 1) data-* attributes flowed into option data
const optA = ts.options.a as { icon?: string; color?: string; text?: string };
if (optA?.icon !== "rocket_launch") fail(`data-icon not read into option data: ${JSON.stringify(optA)}`);
if (optA?.color !== "#993333") fail(`data-color not read into option data: ${JSON.stringify(optA)}`);

// 2) Tom Select adopted our render, and it turns option data into icon glyph + color dot markup.
//    (jsdom has no layout, so options aren't painted on open — we exercise the render directly on the
//    very data Tom Select parsed from the <select> in check 1.)
if (ts.settings.render.option !== renderTomOption) fail("Tom Select did not adopt our option render");
const html = String(ts.settings.render.option(optA, (s: string) => s));
if (!html.includes('class="msym ts-ic">rocket_launch')) fail(`rendered option missing icon: ${html}`);
if (!html.includes("background:#993333")) fail(`rendered option missing color dot: ${html}`);

// 3) search disabled (controlInput:null) → control input not in the live control
if (ts.control_input && ts.control_input.isConnected) fail("controlInput:null still produced a connected search input");

// 4) sync() works after repopulating the underlying <select> (fleet-host path)
sel.innerHTML = `<option value="c" data-icon="computer">Gamma</option>`;
ts.sync();
if (!ts.options.c) fail("sync() did not pick up repopulated options");

// 5) destroy() restores the original element
ts.destroy();
if ((sel as unknown as { tomselect?: unknown }).tomselect) fail("destroy() left a tomselect reference behind");

console.log("✅ Tom Select: data-icon/data-color render, no-search mode, sync(), destroy() all OK");
process.exit(0);
