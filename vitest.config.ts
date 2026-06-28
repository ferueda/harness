import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "test/**/*.test.ts",
      "lib/**/*.test.ts",
      "providers/**/*.test.ts",
      "skills/cursor-cli/**/*.test.ts",
      "skills/sessions/**/*.test.ts",
    ],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
