// Worker entry: runs the untyped occt-import-js tessellator off the daemon's main thread so a
// malformed B-rep that crashes/hangs OCCT can be contained + terminated (DL-8). The parent
// (occt-run.ts) posts { bytes, kind }; we post back a plain-JSON { success, root, meshes } (arrays
// only — no typed arrays, so it survives structured clone cleanly across the thread boundary).

// occt-import-js is untyped; the `any` is confined to this boundary module.
import occtFactory from "occt-import-js";

interface InMsg {
  bytes: Uint8Array;
  kind: "step" | "iges" | "brep";
}

declare const self: Worker & {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null;
  postMessage: (msg: unknown) => void;
};

self.onmessage = async (e: MessageEvent<InMsg>) => {
  try {
    const { bytes, kind } = e.data;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const occt: any = await occtFactory();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let res: any;
    if (kind === "step") res = occt.ReadStepFile(u8, null);
    else if (kind === "iges") res = occt.ReadIgesFile(u8, null);
    else res = occt.ReadBrepFile(u8, null);

    if (!res || !res.success) {
      self.postMessage({ success: false, error: "occt failed to read the file" });
      return;
    }
    // Deep-plain the result: occt already hands back plain arrays/objects, but we re-serialize
    // through JSON to guarantee the structured clone only sees transferable primitives.
    self.postMessage({ success: true, root: res.root, meshes: res.meshes });
  } catch (err) {
    self.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
};
