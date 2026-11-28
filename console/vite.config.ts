import { defineConfig } from "vite";

export default defineConfig({
  base: "/console/",
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist/web", emptyOutDir: true },
});
