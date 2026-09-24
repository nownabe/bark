import { expect, test } from "@playwright/test";
import { installStorage } from "./helpers/mockStorage";

test.use({ viewport: { width: 1920, height: 1080 } });

test("navigate a diagram without selecting source, then explicitly open its source", async ({
  page,
}, testInfo) => {
  await installStorage(page);
  await page.goto("/review.html");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const diagram = page.locator(".dr-mermaid");
  const viewport = diagram.locator(".dr-mermaid__viewport");
  const svg = viewport.locator("svg");
  await expect(svg).toBeVisible();
  // Scrolled to the very bottom, the toolbar can sit under the sticky top bar.
  await diagram.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const original = await svg.getAttribute("viewBox");
  await diagram.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(svg).not.toHaveAttribute("viewBox", original!);
  const zoomed = await svg.getAttribute("viewBox");
  const bounds = (await viewport.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 40, {
    steps: 4,
  });
  await page.mouse.up();
  await expect(svg).not.toHaveAttribute("viewBox", zoomed!);
  await diagram.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect(svg).toHaveAttribute("viewBox", original!);
  await diagram.getByRole("button", { name: "Fit diagram", exact: true }).click();
  await viewport.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  await expect(svg).toHaveAttribute("viewBox", original!);
  await diagram.screenshot({ path: testInfo.outputPath("mermaid-controls.png") });
  const inlineBounds = (await viewport.boundingBox())!;
  await diagram.getByRole("button", { name: "Expand diagram", exact: true }).click();
  const expanded = page.getByRole("dialog", { name: "Expanded Mermaid diagram" });
  await expect(expanded).toBeVisible();
  const expandedViewport = expanded.locator(".dr-mermaid__viewport");
  const expandedBounds = (await expandedViewport.boundingBox())!;
  expect(expandedBounds.width).toBeGreaterThan(inlineBounds.width);
  expect(expandedBounds.height).toBeGreaterThan(inlineBounds.height);
  const modalBounds = (await expanded.boundingBox())!;
  expect(Math.abs(modalBounds.width - page.viewportSize()!.width * 0.9)).toBeLessThan(1);
  expect(Math.abs(modalBounds.height - page.viewportSize()!.height * 0.8)).toBeLessThan(1);
  expect(modalBounds.x).toBeGreaterThan(0);
  expect(modalBounds.y).toBeGreaterThan(0);
  const expandedSvg = expandedViewport.locator("svg");
  const fitted = await expandedSvg.getAttribute("viewBox");
  await expanded.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(expandedSvg).not.toHaveAttribute("viewBox", fitted!);
  await expandedViewport.focus();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(svg).toHaveAttribute("viewBox", original!);
  await expect(diagram.getByRole("button", { name: "Expand diagram", exact: true })).toBeFocused();
  await diagram.getByRole("button", { name: "Expand diagram", exact: true }).click();
  await expanded.getByRole("button", { name: "Close expanded diagram" }).click();
  await expect(expanded).toHaveCount(0);
  await diagram.getByRole("button", { name: "Expand diagram", exact: true }).click();
  await expanded.screenshot({ path: testInfo.outputPath("mermaid-expanded.png") });
  await expanded.getByRole("button", { name: "Edit or comment on diagram source" }).click();
  await expect(expanded).toHaveCount(0);
  await expect(diagram).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("flowchart LR");
  await page.keyboard.insertText("```mermaid\ninvalid diagram syntax\n```");
  await page.keyboard.press("ArrowDown");
  await expect(diagram).toHaveClass(/dr-mermaid--error/);
  await expect(
    diagram.getByRole("button", { name: "Edit or comment on diagram source" }).locator("svg"),
  ).toBeVisible();
  await diagram.getByRole("button", { name: "Edit or comment on diagram source" }).click();
  await expect(diagram).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("invalid diagram syntax");
});
