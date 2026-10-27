import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSrc = (file: string): string => fileURLToPath(new URL(`packages/core/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests import workspace packages from source, so they run without a build.
    alias: [
      { find: /^@loop-engineering\/core\/testing$/, replacement: coreSrc("testing.ts") },
      { find: /^@loop-engineering\/core$/, replacement: coreSrc("index.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
