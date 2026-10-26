// Vite (electron-vite's main build and Vitest) inlines `?raw` imports as strings.
declare module '*?raw' {
  const text: string
  export default text
}
