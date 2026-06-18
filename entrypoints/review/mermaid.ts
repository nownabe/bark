// Mermaid diagram rendering for the preview.
//
// Mermaid is a large dependency and only needed when a ```mermaid block is
// actually present, so it is imported lazily on first render and initialized
// once. securityLevel "strict" sanitizes diagram input (PR content is untrusted).

/** The info string of a fenced-code opening line, lowercased ("```mermaid" → "mermaid"). */
export function fenceInfo(firstLine: string): string {
  return firstLine
    .replace(/^\s*(?:`{3,}|~{3,})/, "")
    .trim()
    .toLowerCase();
}

/** Whether a fenced-code opening line declares a mermaid diagram. */
export function isMermaidFence(firstLine: string): boolean {
  return fenceInfo(firstLine) === "mermaid";
}

type MermaidModule = typeof import("mermaid").default;

let mermaidPromise: Promise<MermaidModule> | null = null;
let seq = 0;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidPromise;
}

/**
 * Render mermaid `code` into `container`, replacing its content with the SVG.
 * On a parse/render error, show the message instead of throwing (a bad diagram
 * shouldn't break the surrounding preview).
 */
export async function renderMermaid(container: HTMLElement, code: string): Promise<void> {
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`dr-mermaid-${seq++}`, code);
    container.innerHTML = svg;
    container.classList.remove("dr-mermaid--error");
  } catch (e) {
    container.classList.add("dr-mermaid--error");
    container.textContent = `Mermaid error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
