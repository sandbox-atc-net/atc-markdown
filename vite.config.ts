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
  },
  test: {
    root: ".",
    include: ["frontend/src/**/*.test.ts"],
  },
});
