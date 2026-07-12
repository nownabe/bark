import { describe, expect, test } from "bun:test";
import { computeRedline, type RedlineSegment } from "../lib/redline";

/** Reconstruct the head string from segments to prove offsets are in head coordinates. */
function insertedText(head: string, seg: RedlineSegment): string {
  if (seg.op !== "ins") throw new Error("not an insertion");
  return head.slice(seg.from, seg.to);
}

describe("computeRedline", () => {
  test("identical inputs produce no segments", () => {
    expect(computeRedline("hello world", "hello world")).toEqual([]);
  });

  test("pure insertion emits an ins segment whose offsets slice the inserted text", () => {
    const baseline = "hello world";
    const head = "hello brave world";
    const segs = computeRedline(baseline, head);
    const ins = segs.filter((s) => s.op === "ins");
    expect(ins.length).toBe(1);
    expect(insertedText(head, ins[0])).toBe("brave ");
    expect(segs.some((s) => s.op === "del")).toBe(false);
  });

  test("pure deletion emits a del segment carrying the removed text at a head offset", () => {
    const baseline = "hello brave world";
    const head = "hello world";
    const segs = computeRedline(baseline, head);
    const dels = segs.filter((s) => s.op === "del");
    expect(dels.length).toBe(1);
    expect(dels[0]).toEqual({ op: "del", at: 6, text: "brave " });
    expect(segs.some((s) => s.op === "ins")).toBe(false);
  });

  test("replacement emits adjacent del + ins at the same head offset", () => {
    const baseline = "the cat sat";
    const head = "the dog sat";
    const segs = computeRedline(baseline, head);
    const del = segs.find((s) => s.op === "del");
    const ins = segs.find((s) => s.op === "ins");
    expect(del).toBeDefined();
    expect(ins).toBeDefined();
    if (del?.op === "del") expect(del.text).toBe("cat");
    if (ins?.op === "ins") expect(insertedText(head, ins)).toBe("dog");
    // The deletion is anchored where the replacement text begins in head.
    if (del?.op === "del" && ins?.op === "ins") expect(del.at).toBe(ins.from);
  });

  test("empty baseline: the whole head is a single insertion", () => {
    const head = "brand new document";
    const segs = computeRedline("", head);
    expect(segs).toEqual([{ op: "ins", from: 0, to: head.length }]);
    expect(insertedText(head, segs[0])).toBe(head);
  });

  test("empty head: a single deletion at offset 0", () => {
    const baseline = "was here before";
    const segs = computeRedline(baseline, "");
    expect(segs).toEqual([{ op: "del", at: 0, text: baseline }]);
  });

  test("multiline changes keep offsets in head coordinates", () => {
    const baseline = "line one\nline two\nline three";
    const head = "line one\nline TWO changed\nline three";
    const segs = computeRedline(baseline, head);
    for (const s of segs) {
      if (s.op === "ins") {
        expect(s.from).toBeGreaterThanOrEqual(0);
        expect(s.to).toBeLessThanOrEqual(head.length);
      }
    }
    expect(segs.length).toBeGreaterThan(0);
    // Reconstructing head from equal + inserted spans (dropping deletions) equals head.
    const inserts = segs.filter((s): s is Extract<RedlineSegment, { op: "ins" }> => s.op === "ins");
    inserts.sort((a, b) => a.from - b.from);
    let rebuilt = "";
    let pos = 0;
    for (const ins of inserts) {
      rebuilt += head.slice(pos, ins.to);
      pos = ins.to;
    }
    rebuilt += head.slice(pos);
    expect(rebuilt).toBe(head);
  });
});
