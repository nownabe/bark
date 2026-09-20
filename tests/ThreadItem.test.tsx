import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ThreadItem, type ThreadItemProps } from "../entrypoints/review/components/ThreadItem";
import type { ExistingComment } from "../lib/comments";
import { sortPos, type ReviewThread } from "../entrypoints/review/reviewItems";

afterEach(cleanup);

function rootComment(over: Partial<ExistingComment> = {}): ExistingComment {
  return {
    id: 1,
    source: "review",
    author: "alice",
    body: "please fix",
    meta: {
      cid: "c1",
      path: "a.md",
      range: { sl: 2, sc: 1, el: 2, ec: 5 },
      quote: "line two",
      sha: "HEAD",
      thread: "t1",
      kind: "comment",
    },
    ...over,
  };
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  const root = over.rootComment ?? rootComment();
  return {
    id: "t1",
    messages: [{ kind: "submitted", comment: root }],
    rootComment: root,
    rootDraft: null,
    path: "a.md",
    pos: sortPos(0, 0),
    quote: "line two",
    hasPending: false,
    hasSubmitted: true,
    resolved: false,
    ...over,
  };
}

function props(over: Partial<ThreadItemProps> = {}): ThreadItemProps {
  return {
    thread: thread(),
    rootStatus: null,
    role: "reviewer",
    canResolve: false,
    canAccept: false,
    decision: undefined,
    isResolving: false,
    emphasized: false,
    replyOpen: false,
    replyText: "",
    onOpen: () => undefined,
    onToggleResolve: () => undefined,
    onAccept: () => undefined,
    onReject: () => undefined,
    onAddReply: () => undefined,
    onCancelReply: () => undefined,
    onReplyTextChange: () => undefined,
    onRemoveDraft: () => undefined,
    ...over,
  };
}

describe("ThreadItem — resolve action", () => {
  test("shows Resolve when canResolve is true", () => {
    const { container } = render(<ThreadItem {...props({ canResolve: true })} />);
    expect(container.querySelector(".thread__resolve")?.textContent).toBe("✓ Resolve");
  });

  test("hides the Resolve button when canResolve is false (issue #182)", () => {
    const { container } = render(<ThreadItem {...props({ canResolve: false })} />);
    expect(container.querySelector(".thread__resolve")).toBeNull();
  });

  test("shows Reopen for a resolved thread", () => {
    const { container } = render(
      <ThreadItem {...props({ canResolve: true, thread: thread({ resolved: true }) })} />,
    );
    expect(container.querySelector(".thread__resolve")?.textContent).toBe("Reopen");
  });

  test("fires onToggleResolve on click without bubbling to onOpen", () => {
    let toggled = 0;
    let opened = 0;
    const { container } = render(
      <ThreadItem
        {...props({ canResolve: true, onToggleResolve: () => toggled++, onOpen: () => opened++ })}
      />,
    );
    fireEvent.click(container.querySelector(".thread__resolve")!);
    expect(toggled).toBe(1);
    expect(opened).toBe(0);
  });

  test("disables the button while a resolve is in flight", () => {
    const { container } = render(
      <ThreadItem {...props({ canResolve: true, isResolving: true })} />,
    );
    const btn = container.querySelector(".thread__resolve") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe("Resolving…");
  });
});

describe("ThreadItem — author suggestion actions", () => {
  const suggestionRoot = rootComment({
    body: "swap it\n\n```suggestion\nLINE TWO\n```",
    meta: {
      cid: "c1",
      path: "a.md",
      range: { sl: 2, sc: 1, el: 2, ec: 5 },
      quote: "line two",
      sha: "HEAD",
      thread: "t1",
      kind: "suggestion",
    },
  });

  test("author sees Accept/Reject on a suggestion root", () => {
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          canAccept: true,
          thread: thread({ rootComment: suggestionRoot }),
        })}
      />,
    );
    const buttons = [...container.querySelectorAll(".comment__actions button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(["Accept", "Reject"]);
  });

  test("a reviewer does not see author actions", () => {
    const { container } = render(
      <ThreadItem
        {...props({ role: "reviewer", thread: thread({ rootComment: suggestionRoot }) })}
      />,
    );
    expect(container.querySelector(".comment__actions")).toBeNull();
  });

  test("Accept is disabled when canAccept is false (issue #176)", () => {
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          canAccept: false,
          thread: thread({ rootComment: suggestionRoot }),
        })}
      />,
    );
    const accept = [...container.querySelectorAll(".comment__actions button")].find(
      (b) => b.textContent === "Accept",
    ) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
  });

  test("an accepted decision replaces the buttons with a status note", () => {
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          decision: "accepted",
          thread: thread({ rootComment: suggestionRoot }),
        })}
      />,
    );
    expect(container.querySelector(".comment__actions button")).toBeNull();
    expect(container.textContent).toContain("accepted — Submit to apply");
  });
});

describe("ThreadItem — reject (issue #287)", () => {
  const suggestionRoot = rootComment({
    body: "swap it\n\n```suggestion\nLINE TWO\n```",
    meta: {
      cid: "c1",
      path: "a.md",
      range: { sl: 2, sc: 1, el: 2, ec: 5 },
      quote: "line two",
      sha: "HEAD",
      thread: "t1",
      kind: "suggestion",
    },
  });

  const rejectButton = (container: HTMLElement) =>
    [...container.querySelectorAll(".comment__actions button")].find(
      (b) => b.textContent === "Reject",
    ) as HTMLButtonElement | undefined;

  test("author actions are hidden on a resolved thread", () => {
    // A rejected suggestion IS a resolved thread now; re-offering Accept /
    // Reject there would invite a second, contradictory decision.
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          canAccept: true,
          thread: thread({ rootComment: suggestionRoot, resolved: true }),
        })}
      />,
    );
    expect(container.querySelector(".comment__actions")).toBeNull();
  });

  test("Reject is disabled when the thread cannot be resolved", () => {
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          canAccept: true,
          canResolve: false,
          thread: thread({ rootComment: suggestionRoot }),
        })}
      />,
    );
    expect(rejectButton(container)?.disabled).toBe(true);
  });

  test("Reject is enabled when the thread can be resolved", () => {
    const { container } = render(
      <ThreadItem
        {...props({
          role: "author",
          canAccept: true,
          canResolve: true,
          thread: thread({ rootComment: suggestionRoot }),
        })}
      />,
    );
    expect(rejectButton(container)?.disabled).toBe(false);
  });
});

describe("ThreadItem — reply composer", () => {
  test("renders the reply textarea only when replyOpen", () => {
    const closed = render(<ThreadItem {...props({ replyOpen: false })} />);
    expect(closed.container.querySelector("textarea")).toBeNull();
    cleanup();
    const open = render(<ThreadItem {...props({ replyOpen: true, replyText: "hi" })} />);
    expect((open.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hi");
  });

  test("Add fires onAddReply", () => {
    let added = 0;
    const { container } = render(
      <ThreadItem {...props({ replyOpen: true, onAddReply: () => added++ })} />,
    );
    const add = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Add",
    ) as HTMLButtonElement;
    fireEvent.click(add);
    expect(added).toBe(1);
  });
});
