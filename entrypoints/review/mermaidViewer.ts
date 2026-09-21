/** Add navigation to an already rendered Mermaid SVG without changing its source. */
export function addMermaidControls(
  container: HTMLElement,
  signal: AbortSignal,
  selectSource: () => void,
): void {
  const svg = container.querySelector("svg");
  const bounds = svg
    ?.getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    !svg ||
    !bounds ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[2]! <= 0 ||
    bounds[3]! <= 0
  ) {
    throw new Error("invalid diagram dimensions");
  }
  const [left, top, width, height] = bounds as [number, number, number, number];
  const viewport = document.createElement("div");
  viewport.className = "dr-mermaid__viewport";
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  viewport.setAttribute(
    "aria-label",
    "Diagram viewer. Arrow keys to pan, plus and minus to zoom, F to fit, 0 to reset.",
  );
  const controls = document.createElement("div");
  controls.className = "dr-mermaid__controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Diagram controls");
  const zoom = document.createElement("output");
  zoom.setAttribute("aria-label", "Diagram zoom");
  const button = (label: string, text: string, action: () => void, iconPath?: string) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "btn btn--sm";
    element.textContent = text;
    if (iconPath) {
      element.classList.add("btn--icon");
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "16");
      icon.setAttribute("height", "16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.5");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", iconPath);
      icon.append(path);
      element.append(icon);
    }
    element.title = label;
    element.setAttribute("aria-label", label);
    element.addEventListener("click", action, { signal });
    controls.append(element);
    return element;
  };

  let centerX = left + width / 2;
  let centerY = top + height / 2;
  let scale = 1;
  let mode: "reset" | "fit" | "manual" = "reset";
  const nextZoom = (direction: 1 | -1) =>
    direction === 1
      ? zoomLevels.find((level) => level > scale + 1e-6)
      : zoomLevels.findLast((level) => level < scale - 1e-6);

  function update() {
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fit = Math.min(rect.width / width, rect.height / height);
    if (mode !== "manual") {
      scale = mode === "fit" ? fit : Math.min(1, fit);
      centerX = left + width / 2;
      centerY = top + height / 2;
    }
    const w = rect.width / scale;
    const h = rect.height / scale;
    svg!.setAttribute("viewBox", `${centerX - w / 2} ${centerY - h / 2} ${w} ${h}`);
    const label = `${Math.round(scale * 100)}%`;
    if (zoom.textContent !== label) zoom.textContent = label;
    zoomOut.disabled = nextZoom(-1) === undefined;
    zoomIn.disabled = nextZoom(1) === undefined;
  }
  function setMode(next: "fit" | "reset") {
    mode = next;
    update();
  }
  function zoomBy(direction: 1 | -1) {
    const next = nextZoom(direction);
    if (next === undefined) return;
    mode = "manual";
    scale = next;
    update();
  }
  button(
    "Fit diagram",
    "",
    () => setMode("fit"),
    "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z",
  );
  const zoomOut = button("Zoom out", "−", () => zoomBy(-1));
  controls.append(zoom);
  const zoomIn = button("Zoom in", "+", () => zoomBy(1));
  button("Reset view", "Reset", () => setMode("reset"));
  let collapse: ((focus?: boolean) => void) | null = null;
  const expand = button("Expand diagram", "Expand", () => {
    if (collapse) return;
    const previous = { centerX, centerY, scale, mode };
    const previousHeight = container.style.height;
    // Preserve the editor's layout while the viewer is in the top layer.
    container.style.height = `${container.getBoundingClientRect().height}px`;
    const dialog = document.createElement("dialog");
    dialog.className = "dr-mermaid--expanded";
    dialog.setAttribute("aria-label", "Expanded Mermaid diagram");
    const restore = (focus = true) => {
      if (collapse !== restore) return;
      collapse = null;
      if (dialog.open) dialog.close();
      container.replaceChildren(controls, viewport);
      container.style.height = previousHeight;
      dialog.remove();
      ({ centerX, centerY, scale, mode } = previous);
      expand.hidden = false;
      close.hidden = true;
      expand.setAttribute("aria-expanded", "false");
      update();
      if (focus && container.isConnected) expand.focus({ preventScroll: true });
    };
    collapse = restore;
    dialog.addEventListener("close", () => restore());
    dialog.append(controls, viewport);
    document.body.append(dialog);
    expand.hidden = true;
    close.hidden = false;
    expand.setAttribute("aria-expanded", "true");
    dialog.showModal();
    setMode("fit");
    close.focus({ preventScroll: true });
  });
  expand.setAttribute("aria-haspopup", "dialog");
  expand.setAttribute("aria-expanded", "false");
  button(
    "Edit or comment on diagram source",
    "",
    () => {
      collapse?.(false);
      selectSource();
    },
    "m8 6-6 6 6 6m8-12 6 6-6 6m-2-16-4 20",
  );
  const close = button("Close expanded diagram", "×", () => collapse?.());
  close.classList.add("btn--icon", "dr-mermaid__close");
  close.hidden = true;
  viewport.append(svg);
  container.replaceChildren(controls, viewport);

  // Keep navigation and button focus out of CodeMirror's selection handlers.
  container.addEventListener("mousedown", (event) => event.stopPropagation(), { signal });
  container.addEventListener("keydown", (event) => event.stopPropagation(), { signal });
  viewport.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key) {
        case "+":
        case "=":
          zoomBy(1);
          break;
        case "-":
          zoomBy(-1);
          break;
        case "f":
        case "F":
          setMode("fit");
          break;
        case "0":
          setMode("reset");
          break;
        case "ArrowLeft":
          centerX += 40 / scale;
          mode = "manual";
          update();
          break;
        case "ArrowRight":
          centerX -= 40 / scale;
          mode = "manual";
          update();
          break;
        case "ArrowUp":
          centerY += 40 / scale;
          mode = "manual";
          update();
          break;
        case "ArrowDown":
          centerY -= 40 / scale;
          mode = "manual";
          update();
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    { signal },
  );

  let drag: { id: number; x: number; y: number } | null = null;
  viewport.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      viewport.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.classList.add("dr-mermaid__viewport--dragging");
    },
    { signal },
  );
  viewport.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      centerX -= (event.clientX - drag.x) / scale;
      centerY -= (event.clientY - drag.y) / scale;
      drag.x = event.clientX;
      drag.y = event.clientY;
      mode = "manual";
      update();
    },
    { signal },
  );
  const stopDrag = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    viewport.classList.remove("dr-mermaid__viewport--dragging");
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    viewport.addEventListener(event, stopDrag, { signal });
  }
  const observer = new ResizeObserver(update);
  observer.observe(viewport);
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      collapse?.(false);
    },
    { once: true },
  );
  update();
}
const zoomLevels = [
  0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10,
];
