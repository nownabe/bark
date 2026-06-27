import { describe, expect, test } from "bun:test";
import { displayPositionToAnchorStatus } from "../entrypoints/review/adapters/displayPositionToAnchorStatus";

describe("displayPositionToAnchorStatus", () => {
  test("'current' maps straight across", () => {
    expect(
      displayPositionToAnchorStatus({
        status: "current",
        range: { sl: 1, sc: 1, el: 1, ec: 1 },
      }),
    ).toBe("current");
  });

  test("'mapped' collapses to 'reanchored' (legacy can't distinguish from 'shifted')", () => {
    expect(
      displayPositionToAnchorStatus({
        status: "mapped",
        range: { sl: 1, sc: 1, el: 1, ec: 1 },
      }),
    ).toBe("reanchored");
  });

  test("'shifted' also collapses to 'reanchored'", () => {
    expect(
      displayPositionToAnchorStatus({
        status: "shifted",
        range: { sl: 1, sc: 1, el: 1, ec: 1 },
      }),
    ).toBe("reanchored");
  });

  test("'outdated' maps straight across", () => {
    expect(displayPositionToAnchorStatus({ status: "outdated" })).toBe("outdated");
  });
});
