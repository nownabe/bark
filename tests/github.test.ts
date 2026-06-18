import { describe, expect, test } from "bun:test";
import {
  avatarUrl,
  buildBlobPermalink,
  buildSuggestionBlock,
  parseNextLink,
  pullStatus,
} from "../lib/github";

describe("pullStatus", () => {
  test("merged wins over everything", () => {
    expect(pullStatus({ state: "closed", merged: true, draft: true })).toBe("merged");
  });
  test("draft when open and not merged", () => {
    expect(pullStatus({ state: "open", draft: true })).toBe("draft");
  });
  test("open / closed otherwise", () => {
    expect(pullStatus({ state: "open" })).toBe("open");
    expect(pullStatus({ state: "closed" })).toBe("closed");
  });
});

describe("avatarUrl", () => {
  test("builds the github.com avatar URL with a size", () => {
    expect(avatarUrl("nownabe")).toBe("https://github.com/nownabe.png?size=40");
    expect(avatarUrl("octocat", 20)).toBe("https://github.com/octocat.png?size=20");
  });
  test("encodes the login", () => {
    expect(avatarUrl("a b")).toBe("https://github.com/a%20b.png?size=40");
  });
});

describe("parseNextLink", () => {
  test("extracts the rel=next URL", () => {
    const link =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe("https://api.github.com/x?page=2");
  });

  test("returns null on the last page / empty / null", () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("buildBlobPermalink", () => {
  const ref = { owner: "o", repo: "r", number: 1 };
  test("multi-line range", () => {
    expect(buildBlobPermalink(ref, "a/b.md", "sha", 3, 5)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3-L5",
    );
  });
  test("single line", () => {
    expect(buildBlobPermalink(ref, "a/b.md", "sha", 3, 3)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3",
    );
  });
});

describe("buildSuggestionBlock", () => {
  test("wraps replacement in a suggestion fence", () => {
    expect(buildSuggestionBlock("const x = 2;")).toBe("```suggestion\nconst x = 2;\n```");
  });
});
