// Playwright E2E for the Bark review page (no extension shell).
// Tests build the extension once, then load `.output/chrome-mv3/review.html`
// over a local static server. GitHub API + browser.storage.local are
// intercepted per-test via the helpers in `tests/e2e/helpers/`.
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4170);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Opt-out hook for hosts whose libc can't run the bundled chromium-
        // headless-shell (e.g. a WSL setup where alsa/glibc come from a nix
        // store that needs newer GLIBC than the WSL host ships). Point
        // PLAYWRIGHT_CHROMIUM_EXECUTABLE at a working chrome/chromium and
        // it'll be used instead. CI / clean Linux falls through to the
        // Playwright-bundled binary.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : undefined,
      },
    },
  ],
  webServer: {
    command: `bun run tests/e2e/helpers/static-server.ts`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
    env: { E2E_PORT: String(port) },
  },
});
