import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/acceptance/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
