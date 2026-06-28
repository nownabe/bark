// Smoke: the review page boots and the no-token gate renders.
// Verifies the static-server / browser-polyfill / mock-GitHub triad
// before the harness grows into real bug-repro tests.
import { expect, test } from "@playwright/test";
import { openReview } from "./helpers/openReview";
import { mockGitHub } from "./helpers/mockGitHub";

test("auth gate appears with no stored token", async ({ page }) => {
  await mockGitHub(page, { unmatched: "404" });
  await openReview(page, { owner: "nownabe", repo: "bark", pr: 1 });
  // LoginGate's "choose method" screen renders two buttons via stable
  // data-test hooks. Targeting those keeps the smoke insensitive to
  // copy tweaks.
  await expect(page.locator("[data-test=choose-app]")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("[data-test=choose-pat]")).toBeVisible();
});
