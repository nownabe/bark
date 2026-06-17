// Selection -> composer anchor handling (tasks 5 + 6 contract).
//
// The reviewer selects text to open the comment composer. When the selection is
// released (collapsed to a cursor), the composer must disappear — i.e. the
// anchor must be reset to null. The old handler only ever *set* a non-null
// anchor, so a released selection left the composer stuck open (the bug).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { handleSelectionUpdate } from "../entrypoints/review/cmAnchor";
import type { SourceAnchor } from "../lib/anchor";

describe("handleSelectionUpdate", () => {
  test("sets the anchor with the quoted text when a non-empty range is selected", () => {
    const calls: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    handleSelectionUpdate(fakeUpdate(view, true), (a) => calls.push(a));
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toBeNull();
    expect(calls[0]!.quotedText).toBe("hello");
    view.destroy();
  });

  test("resets the anchor to null when the selection collapses (composer must close)", () => {
    const calls: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 3, head: 3 } }); // collapsed cursor
    handleSelectionUpdate(fakeUpdate(view, true), (a) => calls.push(a));
    expect(calls).toEqual([null]);
    view.destroy();
  });

  test("does nothing when the update did not change the selection", () => {
    const calls: (SourceAnchor | null)[] = [];
    const view = new EditorView({
      state: EditorState.create({ doc: "hello world" }),
      parent: document.body,
    });
    handleSelectionUpdate(fakeUpdate(view, false), (a) => calls.push(a));
    expect(calls.length).toBe(0);
    view.destroy();
  });
});

// Minimal ViewUpdate stand-in: handleSelectionUpdate only reads `selectionSet`
// and `state`.
function fakeUpdate(view: EditorView, selectionSet: boolean): ViewUpdate {
  return { selectionSet, state: view.state } as unknown as ViewUpdate;
}
