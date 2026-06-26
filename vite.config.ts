/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Savistor is a fully client-side app: there is no backend. We set a relative
// base so the built bundle works when hosted from any subpath (e.g. GitHub Pages).
export default defineConfig({
  base: "./",
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
