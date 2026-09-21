import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, expect, test } from "bun:test";
import { addMermaidControls } from "../entrypoints/review/mermaidViewer";

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  document.body.replaceChildren();
});

function viewer(width = 200, height = 100) {
  const container = document.createElement("div");
  container.innerHTML = `<svg viewBox="10 20 ${width} ${height}"></svg>`;
  document.body.append(container);
  const controller = new AbortController();
  controllers.push(controller);
  let sourceSelections = 0;
  addMermaidControls(container, controller.signal, () => sourceSelections++);
  const viewport = container.querySelector<HTMLElement>(".dr-mermaid__viewport")!;
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const box = () =>
    viewport.querySelector("svg")!.getAttribute("viewBox")!.split(/\s+/).map(Number);
  button("Reset view").click();
  return { container, viewport, button, box, sourceSelections: () => sourceSelections };
}

test("fit fills the viewport while reset restores natural size and position", () => {
  const { button, box } = viewer();
  expect(box()).toEqual([-290, -130, 800, 400]);
  button("Fit diagram").click();
  expect(box()).toEqual([10, 20, 200, 100]);
  button("Zoom in").click();
  expect(box()).toEqual([30, 30, 160, 80]);
  button("Zoom out").click();
  expect(box()).toEqual([10, 20, 200, 100]);
  button("Reset view").click();
  expect(box()).toEqual([-290, -130, 800, 400]);
});

test("expand moves the viewer into a modal and restores its inline view on close", () => {
  const { container, viewport, button, box } = viewer();
  const original = box();
  const expand = button("Expand diagram");
  expect(expand).not.toBeNull();
  expand.click();
  const dialog = document.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(dialog.contains(viewport)).toBe(true);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
  expect(expand.hidden).toBe(true);
  const close = dialog.querySelector<HTMLButtonElement>(
    'button[aria-label="Close expanded diagram"]',
  )!;
  expect(close).not.toBeNull();
  expect(close.textContent).toBe("×");
  dialog.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click();
  close.click();
  expect(document.querySelector("dialog")).toBeNull();
  expect(container.contains(viewport)).toBe(true);
  expect(box()).toEqual(original);
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(expand);
});

test("fit and source use icons with accessible names and tooltips", () => {
  const { button } = viewer();
  for (const label of ["Fit diagram", "Edit or comment on diagram source"]) {
    const control = button(label);
    expect(control.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(control.textContent).toBe("");
    expect(control.title).toBe(label);
  }
});

test("zoom buttons use round presets, including after fitting to an arbitrary size", () => {
  const { button, container } = viewer();
  const zoom = () => container.querySelector("output")!.textContent;
  button("Zoom in").click();
  expect(zoom()).toBe("125%");
  button("Zoom in").click();
  expect(zoom()).toBe("150%");
  button("Zoom out").click();
  expect(zoom()).toBe("125%");
  const fitted = viewer(800 / 0.93, 400 / 0.93);
  fitted.button("Fit diagram").click();
  expect(fitted.container.querySelector("output")!.textContent).toBe("93%");
  fitted.button("Zoom in").click();
  expect(fitted.container.querySelector("output")!.textContent).toBe("100%");
  fitted.button("Zoom out").click();
  expect(fitted.container.querySelector("output")!.textContent).toBe("75%");
});

test("destroying an expanded viewer removes its modal", () => {
  const { button } = viewer();
  const expand = button("Expand diagram");
  expect(expand).not.toBeNull();
  expand.click();
  controllers.at(-1)!.abort();
  expect(document.querySelector("dialog")).toBeNull();
});

test("large diagrams start fitted and zoom remains finite and bounded", () => {
  const { button, box } = viewer(8000, 4000);
  expect(box()).toEqual([10, 20, 8000, 4000]);
  for (let i = 0; i < 100; i++) button("Zoom out").click();
  expect(button("Zoom out").disabled).toBe(true);
  expect(box().every(Number.isFinite)).toBe(true);
  for (let i = 0; i < 100; i++) button("Zoom in").click();
  expect(button("Zoom in").disabled).toBe(true);
  expect(box().every(Number.isFinite)).toBe(true);
});

test("drag pans in diagram coordinates, ends on cancellation, and never selects source", () => {
  const { viewport, button, box, sourceSelections } = viewer();
  viewport.setPointerCapture = () => {};
  viewport.hasPointerCapture = () => false;
  button("Fit diagram").click();
  const pointer = (type: string, x: number, y: number) =>
    viewport.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true }),
    );
  pointer("pointerdown", 100, 100);
  pointer("pointermove", 180, 140);
  expect(box()).toEqual([-10, 10, 200, 100]);
  pointer("pointercancel", 180, 140);
  pointer("pointermove", 260, 180);
  expect(box()).toEqual([-10, 10, 200, 100]);
  expect(sourceSelections()).toBe(0);
  button("Edit or comment on diagram source").click();
  expect(sourceSelections()).toBe(1);
});

test("keyboard controls pan, zoom, fit and reset without reaching the editor", () => {
  const { container, viewport, box } = viewer();
  let bubbled = 0;
  container.parentElement!.addEventListener("keydown", () => bubbled++);
  const key = (key: string) =>
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  key("f");
  key("ArrowRight");
  expect(box()[0]).toBeLessThan(10);
  key("+");
  expect(box()[2]).toBe(160);
  key("-");
  expect(box()[2]).toBe(200);
  key("0");
  expect(box()).toEqual([-290, -130, 800, 400]);
  expect(bubbled).toBe(0);
});
