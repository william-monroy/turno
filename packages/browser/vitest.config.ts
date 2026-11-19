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
    // Most files here start a real Chrome. On a CI runner (3 cores on macOS) one Chrome per core
    // starves them all and turns action timeouts into failures, so CI runs two files at a time.
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
