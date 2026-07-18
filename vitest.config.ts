import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts", "lib/**/*.test.ts", "providers/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
