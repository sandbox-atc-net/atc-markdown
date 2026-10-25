import { defineConfig } from "vite";

// Tauri expects a fixed port and must see Rust errors in the terminal.
export default defineConfig({
  root: "frontend",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    // Mermaid's diagram types are large, but each is loaded only when a document needs it.
    chunkSizeWarningLimit: 2000,
    // Never inline assets as data: URLs (e.g. small KaTeX fonts): the CSP only allows 'self'.
    assetsInlineLimit: 0,
  },
  test: {
    root: ".",
    include: ["frontend/src/**/*.test.ts"],
  },
});
