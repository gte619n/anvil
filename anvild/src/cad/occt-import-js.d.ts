// Ambient declaration for the untyped occt-import-js package. The factory returns a WASM module
// whose Read*File surfaces are dynamic; we type it as `any` at this single boundary (the rest of
// src/cad/ consumes the result through typed converters).
declare module "occt-import-js" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const factory: () => Promise<any>;
  export default factory;
}
