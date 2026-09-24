import { expect, test } from "@playwright/test";
import { handleGitHubRequest, PREVIEW_REF } from "../../dev/preview/fake-github";
import { openReview } from "./helpers/openReview";

// CodeMirror maps a click to a line from the block heights it measured, and
// those exclude vertical margins, so a margined table or diagram shifts every
// click below it onto a later line.
test("a click below a table and a diagram lands on the clicked line", async ({ page }) => {
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
  await expect(page.locator(".dr-table")).toBeVisible();
  await expect(page.locator(".dr-mermaid svg").first()).toBeVisible();

  const heading = page.locator(".dr-hline--2", { hasText: "Rollout" });
  await heading.scrollIntoViewIfNeeded();
  await heading.click();

  await expect(heading).toHaveText("## Rollout");
});
