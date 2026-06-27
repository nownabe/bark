import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { markdown } from "@codemirror/lang-markdown";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { createRef } from "react";
import {
  SourceEditor,
  type SourceEditorProps,
} from "../entrypoints/review/components/SourceEditor";

afterEach(() => {
  cleanup();
});

function makeProps(overrides: Partial<SourceEditorProps> = {}): SourceEditorProps {
  return {
    cmRef: createRef<ReactCodeMirrorRef>(),
    source: "# Hello\n\nLorem.",
    cmExtensions: [markdown()],
    viewMode: "preview",
    onSourceChange: () => {},
    onUpdate: () => {},
    onClick: () => {},
    onMouseDown: () => {},
    onMouseUp: () => {},
    ...overrides,
  };
}

describe("SourceEditor — wrapper layout", () => {
  test("renders a <main> containing the .doc wrapper and a CodeMirror editor", () => {
    const { container } = render(<SourceEditor {...makeProps()} />);
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    const doc = main?.querySelector(".doc");
    expect(doc).not.toBeNull();
    expect(doc?.querySelector(".cm-editor")).not.toBeNull();
  });

  test("the source text reaches the editor's content area", () => {
    const { container } = render(<SourceEditor {...makeProps({ source: "Just text." })} />);
    expect(container.querySelector(".cm-editor")?.textContent).toContain("Just text.");
  });
});

describe("SourceEditor — viewMode → CodeMirror basicSetup", () => {
  test("raw mode shows line numbers (gutter)", () => {
    const { container } = render(<SourceEditor {...makeProps({ viewMode: "raw" })} />);
    expect(container.querySelector(".cm-lineNumbers")).not.toBeNull();
  });

  test("preview mode hides the line-number gutter", () => {
    const { container } = render(<SourceEditor {...makeProps({ viewMode: "preview" })} />);
    expect(container.querySelector(".cm-lineNumbers")).toBeNull();
  });
});

describe("SourceEditor — wrapper mouse handlers", () => {
  test("forwards click / mousedown / mouseup events on the .doc wrapper", () => {
    const onClick = mock(() => {});
    const onMouseDown = mock(() => {});
    const onMouseUp = mock(() => {});
    const { container } = render(
      <SourceEditor {...makeProps({ onClick, onMouseDown, onMouseUp })} />,
    );
    const doc = container.querySelector(".doc") as HTMLDivElement;
    fireEvent.mouseDown(doc);
    fireEvent.mouseUp(doc);
    fireEvent.click(doc);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
    expect(onMouseUp).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
