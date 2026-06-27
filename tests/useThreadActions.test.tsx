import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useThreadActions } from "../entrypoints/review/hooks/useThreadActions";

afterEach(() => {
  cleanup();
});

describe("useThreadActions — initial state", () => {
  test("every field starts at its null / empty value", () => {
    const { result } = renderHook(() => useThreadActions());
    expect(result.current.replyTo).toBeNull();
    expect(result.current.replyText).toBe("");
    expect(result.current.emphasizedThreadId).toBeNull();
    expect(result.current.resolvingId).toBeNull();
  });
});

describe("useThreadActions — reply lifecycle", () => {
  test("startReply opens the reply box for the given thread AND clears any draft text", () => {
    const { result } = renderHook(() => useThreadActions());
    act(() => result.current.setReplyText("half-typed reply"));
    act(() => result.current.startReply("t-1"));
    expect(result.current.replyTo).toBe("t-1");
    expect(result.current.replyText).toBe("");
  });

  test("startReply on a different thread swaps the open reply box", () => {
    const { result } = renderHook(() => useThreadActions());
    act(() => result.current.startReply("t-1"));
    act(() => result.current.setReplyText("hello"));
    act(() => result.current.startReply("t-2"));
    expect(result.current.replyTo).toBe("t-2");
    expect(result.current.replyText).toBe("");
  });

  test("cancelReply clears both the replyTo target and the draft text", () => {
    const { result } = renderHook(() => useThreadActions());
    act(() => result.current.startReply("t-1"));
    act(() => result.current.setReplyText("hello"));
    act(() => result.current.cancelReply());
    expect(result.current.replyTo).toBeNull();
    expect(result.current.replyText).toBe("");
  });
});

describe("useThreadActions — emphasis", () => {
  test("setEmphasizedThreadId sets and clearEmphasis resets it to null", () => {
    const { result } = renderHook(() => useThreadActions());
    act(() => result.current.setEmphasizedThreadId("t-1"));
    expect(result.current.emphasizedThreadId).toBe("t-1");
    act(() => result.current.clearEmphasis());
    expect(result.current.emphasizedThreadId).toBeNull();
  });
});

describe("useThreadActions — resolvingId", () => {
  test("setResolvingId pass-through (used to flag the in-flight resolve / reopen call)", () => {
    const { result } = renderHook(() => useThreadActions());
    act(() => result.current.setResolvingId("t-1"));
    expect(result.current.resolvingId).toBe("t-1");
    act(() => result.current.setResolvingId(null));
    expect(result.current.resolvingId).toBeNull();
  });
});
