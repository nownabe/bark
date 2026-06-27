// The central CodeMirror editor + its `.doc` mouse-handler wrapper.
//
// Pure presentation: every CodeMirror extension and every mouse / selection
// handler comes in via props. The parent (App.tsx) owns the source string,
// the extensions array, the cmRef, and the selection / bubble bookkeeping.

import type { Extension } from "@codemirror/state";
import CodeMirror, { type ReactCodeMirrorRef, type ViewUpdate } from "@uiw/react-codemirror";
import type { MouseEventHandler, RefObject } from "react";
import type { ViewMode } from "../uiHelpers";

export type SourceEditorProps = {
  cmRef: RefObject<ReactCodeMirrorRef>;
  source: string;
  cmExtensions: Extension[];
  viewMode: ViewMode;
  onSourceChange: (source: string) => void;
  onUpdate: (vu: ViewUpdate) => void;
  onClick: MouseEventHandler<HTMLDivElement>;
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  onMouseUp: MouseEventHandler<HTMLDivElement>;
};

export function SourceEditor({
  cmRef,
  source,
  cmExtensions,
  viewMode,
  onSourceChange,
  onUpdate,
  onClick,
  onMouseDown,
  onMouseUp,
}: SourceEditorProps) {
  return (
    <main>
      <div className="doc" onClick={onClick} onMouseDown={onMouseDown} onMouseUp={onMouseUp}>
        <CodeMirror
          ref={cmRef}
          value={source}
          extensions={cmExtensions}
          basicSetup={{
            lineNumbers: viewMode === "raw",
            foldGutter: viewMode === "raw",
            highlightSelectionMatches: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          onChange={onSourceChange}
          onUpdate={onUpdate}
        />
      </div>
    </main>
  );
}
