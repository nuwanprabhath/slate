// The one platform global core may use. Core runs in the renderer (DOM) and in Node (main, MCP,
// sync), so it compiles with neither lib: this file declares only what both provide. It sits
// outside src/ so the root project, which has DOM and Node types, never sees a second declaration.
declare var crypto: {
  randomUUID(): `${string}-${string}-${string}-${string}-${string}`
  getRandomValues<T extends Uint32Array>(array: T): T
}
