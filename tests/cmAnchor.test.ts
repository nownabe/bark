// Selection -> bubble button handling.
//
// Selecting text no longer opens the comment composer directly. The update
// handler only tracks the pending selection (anchor, or null on collapse); the
// bubble button's position is computed separately (on mouse release) via
// bubbleAnchorPoint, and the composer only opens when the bubble is clicked
// (wired in App.tsx).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  handleSelectionUpdate,
  bubbleAnchorPoint,
  cmSelectionToAnchor,
} from "../entrypoints/review/cmAnchor";
import type { SourceAnchor } from "../lib/anchor";

describe("handleSelectionUpdate", () => {
  test("sets the pending selection with the quoted text on a non-empty range", () => {
    const sel: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    handleSelectionUpdate(fakeUpdate(view, true), (a) => sel.push(a));
    expect(sel.length).toBe(1);
    expect(sel[0]).not.toBeNull();
    expect(sel[0]!.quotedText).toBe("hello");
    view.destroy();
  });

  test("clears the selection when it collapses", () => {
    const sel: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 3, head: 3 } }); // collapsed cursor
    handleSelectionUpdate(fakeUpdate(view, true), (a) => sel.push(a));
    expect(sel).toEqual([null]);
    view.destroy();
  });

  test("does nothing when the update did not change the selection", () => {
    const sel: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    handleSelectionUpdate(fakeUpdate(view, false), (a) => sel.push(a));
    expect(sel.length).toBe(0);
    view.destroy();
  });
});

// Issue #291: dragging through a line's newline (or triple-clicking it) ends
// the selection on the NEXT line's first offset. Reporting that line spans a
// line the reviewer never selected, and past the file's trailing newline it
// names a line GitHub does not have — a 422 for the whole batch.
describe("cmSelectionToAnchor on a whole-line selection", () => {
  test("ends on the selected line, not the one the newline leads into", () => {
    const state = EditorState.create({ doc: "line1\nline2", selection: { anchor: 0, head: 6 } });
    const a = cmSelectionToAnchor(state)!;
    expect(a.startLine).toBe(1);
    expect(a.endLine).toBe(1);
    expect(a.endCol).toBe("line1".length + 1);
  });

  test("stays on the last line when the selection ends past the trailing newline", () => {
    const state = EditorState.create({ doc: "line1\n", selection: { anchor: 0, head: 6 } });
    const a = cmSelectionToAnchor(state)!;
    expect(a.endLine).toBe(1);
    expect(a.endCol).toBe("line1".length + 1);
  });

  test("leaves a selection ending mid-line alone", () => {
    const state = EditorState.create({ doc: "line1\nline2", selection: { anchor: 0, head: 9 } });
    const a = cmSelectionToAnchor(state)!;
    expect(a.endLine).toBe(2);
    expect(a.endCol).toBe(4);
  });
});

describe("bubbleAnchorPoint", () => {
  test("places the point below-right of the selection end by the configured gap", () => {
    const p = bubbleAnchorPoint({ bottom: 100, left: 40 }, { gap: 8 });
    expect(p).toEqual({ top: 108, left: 48 });
  });

  test("defaults the gap when none is given", () => {
    const p = bubbleAnchorPoint({ bottom: 50, left: 10 });
    expect(p.top).toBeGreaterThan(50);
    expect(p.left).toBeGreaterThan(10);
  });
});

// Minimal ViewUpdate stand-in: handleSelectionUpdate reads `selectionSet` and
// `state`.
function fakeUpdate(view: EditorView, selectionSet: boolean): ViewUpdate {
  return { selectionSet, state: view.state } as unknown as ViewUpdate;
}
