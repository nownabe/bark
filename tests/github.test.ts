import { describe, expect, test } from "bun:test";
import { avatarUrl, buildBlobPermalink, buildSuggestionBlock, pullStatus } from "../lib/github";

const gdRef = { owner: "o", repo: "r", number: 1 };

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

describe("buildBlobPermalink", () => {
  test("multi-line range", () => {
    expect(buildBlobPermalink(gdRef, "a/b.md", "sha", 3, 5)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3-L5",
    );
  });
  test("single line", () => {
    expect(buildBlobPermalink(gdRef, "a/b.md", "sha", 3, 3)).toBe(
      "https://github.com/o/r/blob/sha/a/b.md#L3",
    );
  });
});

describe("buildSuggestionBlock", () => {
  test("wraps replacement in a suggestion fence", () => {
    expect(buildSuggestionBlock("const x = 2;")).toBe("```suggestion\nconst x = 2;\n```");
  });

  // Regression: a replacement that itself contains a ``` code fence used to be
  // wrapped in a same-length 3-backtick fence, so GitHub's parser closed the
  // outer suggestion block at the inner ``` and truncated the suggestion.
  // CommonMark allows longer fences — pick one longer than any backtick run
  // in the content so the inner fence cannot close the outer one.
  test("uses a longer fence when the replacement contains ```", () => {
    const inner = "before\n```js\nconst x = 1;\n```\nafter";
    expect(buildSuggestionBlock(inner)).toBe("````suggestion\n" + inner + "\n````");
  });

  test("escalates fence length to outrun the longest backtick run in the content", () => {
    const inner = "a ```` four-tick run";
    expect(buildSuggestionBlock(inner)).toBe("`````suggestion\n" + inner + "\n`````");
  });
});
