/** Probe: the custom combobox (web/src/dom.ts enhanceSelect) mirrors a native <select> — rendering
 *  each option's data-icon/data-color, grouping optgroups, hiding the source select, picking a value
 *  back onto it (with a "change" event), refreshing after the options are repopulated, and cleanly
 *  restoring the native control on teardown. Run: bun run test/tools/probe-combobox.ts */
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
    <select id="env">
      <optgroup label="Local">
        <option value="a" data-icon="rocket_launch" data-color="#993333">Alpha</option>
        <option value="b" data-icon="folder" data-color="#335999">Beta</option>
      </optgroup>
    </select>
  </body></html>`,
  { pretendToBeVisual: true },
);
const { window } = dom;
// dom.ts touches the DOM through these globals.
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MutationObserver", "getComputedStyle"]) {
  // @ts-expect-error — wiring jsdom globals onto the bun runtime for the duration of the probe
  globalThis[k] = window[k] ?? globalThis[k];
}

const { enhanceSelect, refreshSelect, destroyModalSelects } = await import("../../web/src/dom");

const fail = (m: string): never => {
  console.error("❌", m);
  process.exit(1);
};

const sel = window.document.getElementById("env") as unknown as HTMLSelectElement;
enhanceSelect(sel, true); // searchable variant (the environment picker)

// 1) the native <select> is hidden but retained as the value source
if (!sel.hidden) fail("source <select> was not hidden");
const wrap = sel.nextElementSibling as HTMLElement | null;
if (!wrap || !wrap.classList.contains("cbx")) fail("combobox wrapper was not inserted after the select");

// 2) the control paints the selected option's icon glyph + color dot + label
const control = wrap!.querySelector(".cbx-control") as HTMLElement;
if (!control) fail("no .cbx-control rendered");
if (!control.innerHTML.includes('class="msym cbx-ic">rocket_launch')) fail(`control missing icon: ${control.innerHTML}`);
if (!control.innerHTML.includes("background:#993333")) fail(`control missing color dot: ${control.innerHTML}`);
if (!control.textContent?.includes("Alpha")) fail(`control missing label: ${control.textContent}`);

// 3) the optgroup became a styled header, and both options are selectable rows
if (!wrap!.querySelector(".cbx-group")) fail("optgroup did not render a group header");
const items = Array.from(wrap!.querySelectorAll(".cbx-item")) as HTMLElement[];
if (items.length !== 2) fail(`expected 2 option rows, got ${items.length}`);

// 4) picking a row writes the value back to the <select> and fires a bubbling "change"
let changed = false;
sel.addEventListener("change", () => (changed = true));
const beta = items.find((el) => el.dataset.value === "b")!;
beta.dispatchEvent(new window.Event("mousedown", { bubbles: true, cancelable: true }));
if (sel.value !== "b") fail(`pick did not update select.value (got ${sel.value})`);
if (!changed) fail("pick did not dispatch a change event");
if (!control.textContent?.includes("Beta")) fail(`control did not update to the picked label: ${control.textContent}`);

// 5) refreshSelect re-reads options after the <select> is repopulated (fleet-host path)
sel.innerHTML = `<option value="c" data-icon="computer">Gamma</option>`;
refreshSelect(sel);
const after = Array.from(wrap!.querySelectorAll(".cbx-item")) as HTMLElement[];
if (after.length !== 1 || after[0]!.dataset.value !== "c") fail("refreshSelect did not pick up repopulated options");

// 6) destroy tears the wrapper down and restores the native control
destroyModalSelects();
if (sel.nextElementSibling) fail("destroy left the wrapper behind");
if (sel.hidden) fail("destroy did not un-hide the native select");

console.log("✅ combobox: renders icon/dot, groups, pick→change, refresh, destroy all OK");
process.exit(0);
