// Open the built review page with a PR ref + optional pre-seeded storage.
import type { Page } from "@playwright/test";
import { installStorage, type StorageSeed } from "./mockStorage";

export type ReviewRef = { owner: string; repo: string; pr: number };

export async function openReview(
  page: Page,
  ref: ReviewRef,
  opts: { storage?: StorageSeed } = {},
): Promise<void> {
  await installStorage(page, opts.storage ?? {});
  const qs = new URLSearchParams({
    owner: ref.owner,
    repo: ref.repo,
    pr: String(ref.pr),
  });
  await page.goto(`/review.html?${qs.toString()}`);
}
