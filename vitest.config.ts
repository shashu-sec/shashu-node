import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The network guard (test/setup.ts) applies to every file: see its header.
    setupFiles: ["./test/setup.ts"],
  },
});
