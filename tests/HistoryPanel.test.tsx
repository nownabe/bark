import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  HistoryPanel,
  type HistoryCommentRow,
  type HistoryPanelProps,
} from "../entrypoints/review/components/HistoryPanel";
import type { Round } from "../lib/pr/rounds";
import type { PrCommit, PrReview } from "../lib/pr/types";

afterEach(() => {
  cleanup();
});

const alice = { login: "alice" };
const bob = { login: "bob" };

function review(overrides: Partial<PrReview> = {}): PrReview {
  return {
    id: 1,
    author: alice,
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-07-01T00:00:00Z",
    commitId: "aaaaaaa000",
    ...overrides,
  };
}

function commit(overrides: Partial<PrCommit> = {}): PrCommit {
  return {
    sha: "bbbbbbb111",
    message: "Fix the thing\n\nlonger body",
    author: bob,
    committedAt: "2026-07-01T01:00:00Z",
    parents: [],
    ...overrides,
  };
}

function round(overrides: Partial<Round> = {}): Round {
  return {
    index: 0,
    baseSha: "aaaaaaa000",
    reviews: [review()],
    addressingCommits: [commit()],
    orphaned: false,
    ...overrides,
  };
}

function makeProps(overrides: Partial<HistoryPanelProps> = {}): HistoryPanelProps {
  return {
    rounds: [round()],
    commentsByRound: new Map<string, HistoryCommentRow[]>(),
    highlightedSha: null,
    onJumpToCommit: () => {},
    ...overrides,
  };
}

describe("HistoryPanel — empty state", () => {
  test("shows the empty message when there are no rounds", () => {
    const { container } = render(<HistoryPanel {...makeProps({ rounds: [] })} />);
    expect(container.textContent).toContain("No review rounds yet");
    expect(container.querySelector(".history__round")).toBeNull();
  });
});

describe("HistoryPanel — round headers", () => {
  test("renders one round header per round with 'Round N @ <sha7>'", () => {
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          rounds: [
            round({ index: 0, baseSha: "aaaaaaa000" }),
            round({
              index: 1,
              baseSha: "ccccccc222",
              reviews: [review({ commitId: "ccccccc222" })],
            }),
          ],
        })}
      />,
    );
    const headers = Array.from(container.querySelectorAll(".history__round-title"));
    expect(headers).toHaveLength(2);
    expect(headers[0]?.textContent).toContain("Round 1");
    expect(headers[0]?.textContent).toContain("aaaaaaa"); // sha7
    expect(headers[1]?.textContent).toContain("Round 2");
    expect(headers[1]?.textContent).toContain("ccccccc");
  });

  test("shows each review's state and author", () => {
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          rounds: [
            round({
              reviews: [
                review({ id: 1, author: alice, state: "CHANGES_REQUESTED" }),
                review({ id: 2, author: bob, state: "APPROVED" }),
              ],
            }),
          ],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("alice");
    expect(text).toContain("bob");
    expect(container.querySelector(".history__review-state")?.textContent?.length).toBeGreaterThan(
      0,
    );
  });

  test("marks an orphaned round with a subtle marker", () => {
    const { container } = render(
      <HistoryPanel {...makeProps({ rounds: [round({ orphaned: true })] })} />,
    );
    expect(container.querySelector(".history__round--orphaned")).not.toBeNull();
    expect(container.textContent).toContain("orphaned");
  });
});

describe("HistoryPanel — addressing commits", () => {
  test("renders each addressing commit as '<sha7> (author) — first line'", () => {
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          rounds: [
            round({
              addressingCommits: [
                commit({ sha: "bbbbbbb111", author: bob, message: "Fix the thing\nsecond line" }),
              ],
            }),
          ],
        })}
      />,
    );
    const row = container.querySelector(".history__commit");
    expect(row).not.toBeNull();
    const text = row?.textContent ?? "";
    expect(text).toContain("bbbbbbb"); // sha7
    expect(text).toContain("bob");
    expect(text).toContain("Fix the thing");
    expect(text).not.toContain("second line"); // only the first line
  });

  test("highlights the commit whose sha matches highlightedSha", () => {
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          rounds: [round({ addressingCommits: [commit({ sha: "bbbbbbb111" })] })],
          highlightedSha: "bbbbbbb111",
        })}
      />,
    );
    const el = container.querySelector('[data-commit-sha="bbbbbbb111"]');
    expect(el?.className).toContain("history__commit--highlight");
  });
});

describe("HistoryPanel — comment rows and badges", () => {
  test("renders comment rows with a status badge per comment", () => {
    const rows: HistoryCommentRow[] = [
      { id: "c1", author: "alice", quote: "hello", status: { status: "open" } },
      { id: "c2", author: "bob", quote: "world", status: { status: "resolved" } },
      { id: "c3", author: "carol", quote: "foo", status: { status: "outdated" } },
    ];
    const { container } = render(
      <HistoryPanel {...makeProps({ commentsByRound: new Map([["aaaaaaa000", rows]]) })} />,
    );
    expect(container.querySelectorAll(".history__comment")).toHaveLength(3);
    expect(container.querySelector(".badge--resolved")).not.toBeNull();
    expect(container.querySelector(".badge--outdated")).not.toBeNull();
  });

  test("an addressed comment shows a clickable 'fixed in <sha7>' chip that fires onJumpToCommit", () => {
    const onJumpToCommit = mock((_sha: string) => {});
    const rows: HistoryCommentRow[] = [
      {
        id: "c1",
        author: "alice",
        quote: "hello",
        status: { status: "addressed", addressedBySha: "bbbbbbb111" },
      },
    ];
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          commentsByRound: new Map([["aaaaaaa000", rows]]),
          onJumpToCommit,
        })}
      />,
    );
    const chip = container.querySelector(".history__addressed-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("fixed in");
    expect(chip.textContent).toContain("bbbbbbb"); // sha7
    fireEvent.click(chip);
    expect(onJumpToCommit).toHaveBeenCalledWith("bbbbbbb111");
  });

  test("an outdated comment that also carries addressedBySha still shows a fixed-in chip", () => {
    const onJumpToCommit = mock((_sha: string) => {});
    const rows: HistoryCommentRow[] = [
      {
        id: "c1",
        author: "alice",
        quote: "hello",
        status: { status: "outdated", addressedBySha: "bbbbbbb111" },
      },
    ];
    const { container } = render(
      <HistoryPanel
        {...makeProps({
          commentsByRound: new Map([["aaaaaaa000", rows]]),
          onJumpToCommit,
        })}
      />,
    );
    expect(container.querySelector(".badge--outdated")).not.toBeNull();
    const chip = container.querySelector(".history__addressed-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    fireEvent.click(chip);
    expect(onJumpToCommit).toHaveBeenCalledWith("bbbbbbb111");
  });
});
