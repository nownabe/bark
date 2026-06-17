import { describe, expect, test } from "bun:test";
import { isSubmitChord } from "../entrypoints/review/keys";

describe("isSubmitChord", () => {
  test("Cmd+Enter is the submit chord", () => {
    expect(isSubmitChord({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
  });
  test("Ctrl+Enter is the submit chord", () => {
    expect(isSubmitChord({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
  });
  test("plain Enter is not the submit chord", () => {
    expect(isSubmitChord({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });
  test("Cmd/Ctrl with another key is not the submit chord", () => {
    expect(isSubmitChord({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
    expect(isSubmitChord({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
  });
});
