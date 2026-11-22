/**
 * Shared by `protocol-surface.test.ts` and `regen-golden.ts`. Lives outside the test file because
 * importing a `*.test.ts` from a plain script calls `bun:test`'s `test()` outside the runner, which
 * throws ("Cannot use test() outside of the test runner"), so the regen script used to crash.
 */

/** Extract every `type: "wire.name"` literal from the protocol source, sorted + de-duped. */
export function extractWireTypes(src: string): string[] {
  const out = new Set<string>();
  const re = /^\s*type:\s*"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]!);
  return [...out].sort();
}
