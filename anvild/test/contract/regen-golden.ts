/**
 * Regenerate the protocol contract golden after an INTENTIONAL protocol change.
 * Run: cd anvild && bun test/contract/regen-golden.ts
 *
 * This deliberately requires a manual step. Regenerating is the checkpoint to update every client
 * (web PWA, Swift, Kotlin) for the added/removed/renamed wire type before the change merges.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@protocol";
import { extractWireTypes } from "./protocol-surface.test";

const HERE = import.meta.dir;
const wireTypes = extractWireTypes(readFileSync(join(HERE, "..", "..", "protocol.ts"), "utf8"));
writeFileSync(
  join(HERE, "protocol-surface.golden.json"),
  JSON.stringify({ protocolVersion: PROTOCOL_VERSION, wireTypes }, null, 2) + "\n",
);
console.log(`wrote golden: PROTOCOL_VERSION=${PROTOCOL_VERSION}, ${wireTypes.length} wire types`);
