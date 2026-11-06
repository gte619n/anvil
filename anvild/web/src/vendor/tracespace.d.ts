// Types for the vendored tracespace bundle (./tracespace.js). The runtime code is the committed,
// self-contained bundle (owner verdict V3); the real types still come from the npm packages, which
// remain installed for type-checking + rebuilding the bundle.
import type pcbStackupDefault from "pcb-stackup";
import type gerberToSvgDefault from "gerber-to-svg";

export const pcbStackup: typeof pcbStackupDefault;
export const gerberToSvg: typeof gerberToSvgDefault;
