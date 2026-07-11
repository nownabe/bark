// Rendering tests for Markdown links in Preview view.
//
// In Preview mode (richMarkdown.ts) a Markdown link `[text](url)` should render
// as a real, clickable anchor showing only the link text — the `[`, `]`, and
// `(url)` source markers are hidden while the cursor is outside the link. When
// the cursor moves into the link the canonical source is shown for editing.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { richMarkdown, richMarkdownTheme } from "../entrypoints/review/richMarkdown";

// Build a Preview-mode view (matching App.tsx preview extensions) with the
// cursor placed at `cursor` (default 0, i.e. outside any link).
function render(doc: string, cursor = 0): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ extensions: [GFM] }), richMarkdown, richMarkdownTheme],
    }),
    parent: document.body,
  });
}

describe("preview mode: Markdown links render as clickable anchors", () => {
  test("a link renders as an <a> with the destination href and link text", () => {
    const view = render("See [link](https://example.com) here.");
    const a = view.dom.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com");
    expect(a!.textContent).toBe("link");
    // A reviewer must be able to follow the link — it opens in a new tab.
    expect(a!.getAttribute("target")).toBe("_blank");
    expect(a!.getAttribute("rel")).toContain("noopener");
    view.destroy();
  });

  test("the source markers ([, ], (url)) are not visible in the rendered line", () => {
    const view = render("See [link](https://example.com) here.");
    // The visible text of the editor line must read "See link here." — the
    // brackets and URL markers must be hidden.
    const text = view.dom.querySelector(".cm-line")?.textContent ?? "";
    expect(text).toContain("See ");
    expect(text).toContain("link");
    expect(text).toContain(" here.");
    expect(text).not.toContain("[");
    expect(text).not.toContain("]");
    expect(text).not.toContain("https://example.com");
    view.destroy();
  });

  test("the canonical source is shown when the cursor is inside the link", () => {
    // Cursor placed inside the link (offset 6, within "link").
    const view = render("See [link](https://example.com) here.", 6);
    const text = view.dom.querySelector(".cm-line")?.textContent ?? "";
    expect(text).toContain("[link](https://example.com)");
    view.destroy();
  });
});

describe("preview mode: unsafe URL schemes are not emitted as hrefs (#86)", () => {
  // PR Markdown is untrusted; only http/https/mailto may become a real link.
  // Everything else renders as inert text (an anchor without href).
  const inert = (url: string) => {
    // "See " keeps the default cursor (offset 0) outside the link so the
    // widget renders instead of the editable source.
    const view = render(`See [click](${url})`);
    const a = view.dom.querySelector("a.dr-link");
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("href")).toBe(false);
    view.destroy();
  };

  test("javascript: links render without href", () => {
    inert("javascript:alert(1)");
  });

  test("scheme matching is case-insensitive", () => {
    inert("JaVaScRiPt:alert(1)");
  });

  test("data: links render without href", () => {
    inert("data:text/html,<script>alert(1)</script>");
  });

  test("relative links render without href (would resolve to the extension page)", () => {
    inert("./other.md");
  });

  test("mailto: links keep their href", () => {
    const view = render("See [mail](mailto:a@example.com)");
    const a = view.dom.querySelector("a.dr-link");
    expect(a!.getAttribute("href")).toBe("mailto:a@example.com");
    view.destroy();
  });
});
