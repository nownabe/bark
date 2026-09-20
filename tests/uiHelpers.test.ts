import { describe, expect, test } from "bun:test";
import {
  canAcceptSuggestion,
  errMessage,
  installUrl,
  PR_STATUS_LABEL,
  STATUS_LABEL,
} from "../entrypoints/review/uiHelpers";
import { GitHubApiError } from "../lib/pr/github-api";

describe("errMessage", () => {
  test("401 → user-facing authentication error message", () => {
    expect(errMessage(new GitHubApiError(401, "Unauthorized"))).toBe(
      "Authentication error (401). Check the token's permissions/expiry.",
    );
  });

  test("403 → user-facing authentication error message", () => {
    expect(errMessage(new GitHubApiError(403, "Forbidden"))).toBe(
      "Authentication error (403). Check the token's permissions/expiry.",
    );
  });

  test("404 → 'Not Found' hint pointing at repo / PR / token permissions", () => {
    expect(errMessage(new GitHubApiError(404, "ignored"))).toBe(
      "Not Found (404). Check the repository / PR / token permissions.",
    );
  });

  test("other GitHubApiError status passes the underlying message through", () => {
    expect(errMessage(new GitHubApiError(500, "Boom"))).toBe("GitHub API 500: Boom");
  });

  test("plain Error → its message", () => {
    expect(errMessage(new Error("oops"))).toBe("oops");
  });

  test("non-Error values coerce via String()", () => {
    expect(errMessage("nope")).toBe("nope");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
  });
});

describe("STATUS_LABEL", () => {
  test("non-current anchor states map to user-facing labels", () => {
    expect(STATUS_LABEL.reanchored).toBe("position shifted");
    expect(STATUS_LABEL.outdated).toBe("position not found");
  });

  test("'current' has no label — the normal state should not surface", () => {
    expect(STATUS_LABEL.current).toBeUndefined();
  });
});

describe("PR_STATUS_LABEL", () => {
  test("covers every PullStatus with a capitalised label", () => {
    expect(PR_STATUS_LABEL).toEqual({
      open: "Open",
      merged: "Merged",
      draft: "Draft",
      closed: "Closed",
    });
  });
});

describe("canAcceptSuggestion", () => {
  const range = { sl: 2, sc: 1, el: 2, ec: 1 };

  test("current and mapped positions are acceptable", () => {
    expect(canAcceptSuggestion({ status: "current", range })).toBe(true);
    expect(canAcceptSuggestion({ status: "mapped", range })).toBe(true);
  });

  // Issue #269: a shifted target is offered again. The line-local merge in
  // applyAcceptedSuggestion refuses on its own when the suggestion's hunks
  // don't apply, so the gate no longer has to pre-emptively hide the button.
  test("a shifted position is acceptable — the merge is the gate", () => {
    expect(canAcceptSuggestion({ status: "shifted", range })).toBe(true);
  });

  test("an outdated position is refused (issue #176)", () => {
    expect(canAcceptSuggestion({ status: "outdated" })).toBe(false);
  });

  test("missing view (bootstrap in flight) is refused", () => {
    expect(canAcceptSuggestion(null)).toBe(false);
    expect(canAcceptSuggestion(undefined)).toBe(false);
  });
});

describe("installUrl", () => {
  test("either null (no app slug configured) or a GitHub install URL for the configured slug", () => {
    if (installUrl === null) {
      expect(installUrl).toBeNull();
    } else {
      expect(installUrl).toMatch(/^https:\/\/github\.com\/apps\/.+\/installations\/new$/);
    }
  });
});
