// Selection -> bubble button handling.
//
// Selecting text no longer opens the comment composer directly. Instead it
// drives a "pending selection" (which shows a bubble button just above the
// selection) plus the button's viewport position. The composer only opens when
// that bubble is clicked (wired in App.tsx). When the selection collapses, the
// pending selection and the bubble are cleared.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { handleSelectionUpdate, bubbleAnchorPoint } from "../entrypoints/review/cmAnchor";
import type { SourceAnchor } from "../lib/anchor";
import type { BubblePos } from "../entrypoints/review/cmAnchor";

describe("handleSelectionUpdate", () => {
  test("sets the pending selection with the quoted text on a non-empty range", () => {
    const sel: (SourceAnchor | null)[] = [];
    const pos: (BubblePos | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    handleSelectionUpdate(fakeUpdate(view, true), {
      setSelection: (a) => sel.push(a),
      setBubblePos: (p) => pos.push(p),
    });
    expect(sel.length).toBe(1);
    expect(sel[0]).not.toBeNull();
    expect(sel[0]!.quotedText).toBe("hello");
    // happy-dom has no layout, so coordsAtPos returns null -> bubble hidden.
    expect(pos).toEqual([null]);
    view.destroy();
  });

  test("clears the selection and bubble when the selection collapses", () => {
    const sel: (SourceAnchor | null)[] = [];
    const pos: (BubblePos | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 3, head: 3 } }); // collapsed cursor
    handleSelectionUpdate(fakeUpdate(view, true), {
      setSelection: (a) => sel.push(a),
      setBubblePos: (p) => pos.push(p),
    });
    expect(sel).toEqual([null]);
    expect(pos).toEqual([null]);
    view.destroy();
  });

  test("does nothing when the update did not change the selection", () => {
    const sel: (SourceAnchor | null)[] = [];
    const pos: (BubblePos | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    handleSelectionUpdate(fakeUpdate(view, false), {
      setSelection: (a) => sel.push(a),
      setBubblePos: (p) => pos.push(p),
    });
    expect(sel.length).toBe(0);
    expect(pos.length).toBe(0);
    view.destroy();
  });
});

describe("bubbleAnchorPoint", () => {
  test("places the point the configured gap above the selection top", () => {
    const p = bubbleAnchorPoint({ top: 100, left: 40 }, { gap: 8 });
    expect(p).toEqual({ top: 92, left: 40 });
  });

  test("defaults the gap when none is given", () => {
    const p = bubbleAnchorPoint({ top: 50, left: 10 });
    expect(p.left).toBe(10);
    expect(p.top).toBeLessThan(50);
  });
});

// Minimal ViewUpdate stand-in: handleSelectionUpdate reads `selectionSet`,
// `state`, and `view` (for coordsAtPos).
function fakeUpdate(view: EditorView, selectionSet: boolean): ViewUpdate {
  return { selectionSet, state: view.state, view } as unknown as ViewUpdate;
}
