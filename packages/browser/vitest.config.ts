import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A throwaway HOME for the whole run that fails the run if anything lands in it, and one
    // build of dist/ before any file starts the server from it.
    globalSetup: ["test/helpers/global-setup.ts", "test/helpers/build-dist.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
  },
});
