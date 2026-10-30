import { defineConfig } from "vitest/config";

// Real Microsoft Edge (installed, not downloaded) driving the real built app against a real SQLite profile. Needs `npm run build`.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
