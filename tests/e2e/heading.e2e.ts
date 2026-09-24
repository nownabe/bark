import { expect, test } from "@playwright/test";
import { handleGitHubRequest, PREVIEW_REF } from "../../dev/preview/fake-github";
import { openReview } from "./helpers/openReview";

// Preview drops the syntax highlighter's heading underline, but a reviewer's
// deletion inside a heading must still read as struck through.
test("a deletion inside a heading keeps its strikethrough", async ({ page }) => {
  await page.route(/^https:\/\/api\.github\.com\//, async (route) => {
    const req = route.request();
    const res = handleGitHubRequest(req.url(), { method: req.method(), body: req.postData() });
    await route.fulfill({ status: res.status, body: await res.text() });
  });
  await openReview(
    page,
    { owner: PREVIEW_REF.owner, repo: PREVIEW_REF.repo, pr: PREVIEW_REF.number },
    { storage: { github_token: "preview", auth_method: "pat" } },
  );
  const heading = page.locator(".dr-hline--1");
  await expect(heading).toContainText("Offline sync for the mobile client");
  await heading.click();
  await page.keyboard.press("End");
  for (let i = 0; i < " client".length; i++) await page.keyboard.press("Backspace");

  const deleted = heading.locator(".dr-del");
  await expect(deleted).toHaveText(" client");
  await expect(deleted).toHaveCSS("text-decoration-line", "line-through");
  await expect(heading.locator(".dr-h1").first()).toHaveCSS("text-decoration-line", "none");
});
