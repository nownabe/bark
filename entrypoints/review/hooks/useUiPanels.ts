// Modal + popover + FAB visibility flags.
//
// Collects the boolean flags for the five overlay surfaces (Submit confirm,
// Discard confirm, PR info popover, Help popover, Debug popover) plus the
// DOM refs the popovers need so an outside mouse-down can close them.
//
// The submit / discard confirmations are plain modals (no outside-click DOM
// logic), so they expose the conventional show + setShow pair. The popovers
// expose `toggle*` / `close*` actions because the caller doesn't poke them
// imperatively beyond that.

import { useEffect, useRef, useState, type RefObject } from "react";

export type UiPanels = {
  showSubmitConfirm: boolean;
  setShowSubmitConfirm: (v: boolean) => void;

  showDiscardConfirm: boolean;
  setShowDiscardConfirm: (v: boolean) => void;

  showPrInfo: boolean;
  togglePrInfo: () => void;
  prInfoBtnRef: RefObject<HTMLButtonElement | null>;
  prInfoRef: RefObject<HTMLDivElement | null>;

  showHelp: boolean;
  toggleHelp: () => void;
  closeHelp: () => void;
  helpBtnRef: RefObject<HTMLButtonElement | null>;
  helpRef: RefObject<HTMLDivElement | null>;

  showDebug: boolean;
  toggleDebug: () => void;
  closeDebug: () => void;
};

export function useUiPanels(): UiPanels {
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [showPrInfo, setShowPrInfo] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  // popover refs (used by both render and the outside-click effects).
  const prInfoBtnRef = useRef<HTMLButtonElement>(null);
  const prInfoRef = useRef<HTMLDivElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);

  // PR info: outside-click closes (treat the toggle button itself as inside).
  useEffect(() => {
    if (!showPrInfo) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (prInfoRef.current?.contains(t) || prInfoBtnRef.current?.contains(t)) return;
      setShowPrInfo(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showPrInfo]);

  // Help popover: same pattern.
  useEffect(() => {
    if (!showHelp) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (helpRef.current?.contains(t) || helpBtnRef.current?.contains(t)) return;
      setShowHelp(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showHelp]);

  return {
    showSubmitConfirm,
    setShowSubmitConfirm,
    showDiscardConfirm,
    setShowDiscardConfirm,
    showPrInfo,
    togglePrInfo: () => setShowPrInfo((v) => !v),
    prInfoBtnRef,
    prInfoRef,
    showHelp,
    toggleHelp: () => setShowHelp((v) => !v),
    closeHelp: () => setShowHelp(false),
    helpBtnRef,
    helpRef,
    showDebug,
    toggleDebug: () => setShowDebug((v) => !v),
    closeDebug: () => setShowDebug(false),
  };
}
