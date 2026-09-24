// A fake api.github.com for the local preview: one fixture PR with the
// thread states the review UI has to render. Reads only — every write is
// refused, so the preview can never look like it posted something.
import { buildLineIndex, offsetToLineCol } from "../../lib/anchor";
import { buildSuggestionBlock } from "../../lib/github";
import { embedMetadata } from "../../lib/pr/metadata";
import type { Anchor } from "../../lib/pr/types";

export const PREVIEW_REF = { owner: "bark-preview", repo: "handbook", number: 1 };

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
// Real public accounts: the UI loads avatars from github.com/<login>.png, so
// made-up logins would render as broken images.
const user = (login: string) => ({ login, avatar_url: `https://github.com/${login}.png` });
const AUTHOR = user("octocat");
const REVIEWER = user("hubot");
const OUTSIDER = user("monalisa");

const DESIGN_DOC = `# Offline sync for the mobile client

**Status:** Draft · **Owner:** platform team · **Reviewers:** mobile, infra

## Background

The mobile client currently requires a live connection for every write. Field users on flaky networks lose edits when a request times out, and support tickets about "lost changes" have tripled since the last release. This document proposes a local-first write path with background reconciliation.

## Goals

- Never lose a user edit, even when the app is killed mid-request.
- Keep the server as the single source of truth for conflicts.
- Ship behind a feature flag and roll out to 5% of users first.

## Non-goals

1. Real-time collaboration between devices.
2. Changing the server-side data model.

## Design

Every write is appended to a durable \`outbox\` table before it is sent. A background worker drains the outbox in order and marks entries as acknowledged once the server responds with \`2xx\`.

> Open question: should the outbox be per-account or per-device? Per-device is simpler but makes account switching awkward.

\`\`\`ts
interface OutboxEntry {
  id: string;
  op: "create" | "update" | "delete";
  payload: unknown;
  attempts: number;
}
\`\`\`

### Conflict handling

| Case | Server state | Resolution |
| --- | --- | --- |
| Stale update | newer version | reject, surface to user |
| Delete after edit | deleted | drop local edit |
| Duplicate create | exists | treat as success |

When a conflict is rejected, the client keeps the local copy and shows a banner so the user can decide. See the [retry policy](https://example.com/retry) for backoff details.

\`\`\`mermaid
flowchart LR
  W[Write] --> O[(Outbox)]
  O --> S{Server}
  S -->|2xx| A[Acknowledge]
  S -->|409| C[Conflict banner]
\`\`\`

## Rollout

We ship the outbox dark first, then enable reconciliation for internal users, then 5%, 25%, and 100% over three weeks.
`;

const RUNBOOK = `# Outbox runbook

## Draining a stuck outbox

1. Check the worker logs for repeated \`409\` responses.
2. Export the entries with \`outbox dump --account <id>\`.
3. Clear only acknowledged entries; never delete pending ones.
`;

const FILES: Record<string, string> = {
  "docs/offline-sync.md": DESIGN_DOC,
  "docs/outbox-runbook.md": RUNBOOK,
};
const DOC_PATH = "docs/offline-sync.md";

/** The anchor Bark would record for `quote` (its first occurrence) in `source`. */
function anchorOf(source: string, quote: string): Anchor {
  const start = source.indexOf(quote);
  if (start < 0) throw new Error(`preview fixture: quote not found: ${quote}`);
  const lines = buildLineIndex(source);
  const s = offsetToLineCol(start, lines);
  const e = offsetToLineCol(start + quote.length, lines);
  return { sha: HEAD_SHA, range: { sl: s.line, sc: s.col, el: e.line, ec: e.col }, quote };
}

type ReviewComment = {
  id: number;
  body: string;
  path: string;
  line: number;
  in_reply_to_id?: number;
  user: typeof AUTHOR;
  created_at: string;
};

/** A comment posted by Bark: the hidden fence carries its identity and anchor. */
function barkComment(
  id: number,
  thread: string,
  user: typeof AUTHOR,
  quote: string,
  body: string,
): ReviewComment {
  const anchor = anchorOf(DESIGN_DOC, quote);
  return {
    id,
    body: embedMetadata(body, { cid: `preview-c${id}`, threadId: thread, path: DOC_PATH, anchor }),
    path: DOC_PATH,
    line: anchor.range.el,
    user,
    created_at: `2026-09-2${id % 10}T09:00:00Z`,
  };
}

/** A comment posted on github.com directly: no fence, so Bark treats it as foreign. */
function nativeComment(
  id: number,
  user: typeof AUTHOR,
  body: string,
  at: { line: number; in_reply_to_id?: number },
): ReviewComment {
  return { id, body, path: DOC_PATH, user, created_at: `2026-09-2${id % 10}T10:00:00Z`, ...at };
}

const SUGGESTED_LINE = "- Keep the server as the single source of truth for conflicts.";
const TABLE_ROW = "| Stale update | newer version | reject, surface to user |";
const lineOf = (text: string) => anchorOf(DESIGN_DOC, text).range.sl;

const REVIEW_COMMENTS: ReviewComment[] = [
  barkComment(
    101,
    "preview-t1",
    REVIEWER,
    "should the outbox be per-account or per-device?",
    "Per-device seems safer here. With per-account, the account switcher ends up draining another user's queue, which feels like the wrong owner for that work.",
  ),
  nativeComment(
    102,
    AUTHOR,
    "Agreed. I'll switch to per-device and call out the account-switch cost.",
    {
      line: lineOf("> Open question"),
      in_reply_to_id: 101,
    },
  ),
  barkComment(
    103,
    "preview-t2",
    REVIEWER,
    SUGGESTED_LINE,
    `Conflicts are resolved on the server, but the client still decides what to show.\n\n${buildSuggestionBlock("- Keep the server as the single source of truth for conflict resolution.")}`,
  ),
  barkComment(
    104,
    "preview-t3",
    REVIEWER,
    "tripled since the last release",
    "Can we link the support dashboard for this number?",
  ),
  nativeComment(105, AUTHOR, "Linked it in the appendix.", {
    line: lineOf("The mobile client currently"),
    in_reply_to_id: 104,
  }),
  nativeComment(106, OUTSIDER, 'Nit: "surface to user" reads oddly. Maybe "show a banner"?', {
    line: lineOf(TABLE_ROW),
  }),
];

const THREADS = [
  { id: "PRRT_preview1", isResolved: false, ids: [101, 102] },
  { id: "PRRT_preview2", isResolved: false, ids: [103] },
  { id: "PRRT_preview3", isResolved: true, ids: [104, 105] },
  { id: "PRRT_preview4", isResolved: false, ids: [106] },
];

function addedPatch(source: string): string {
  const lines = source.replace(/\n$/, "").split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

function base64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer an api.github.com request from the fixture. */
export function handleGitHubRequest(url: string, init?: RequestInit): Response {
  const method = (init?.method ?? "GET").toUpperCase();
  const { pathname, searchParams } = new URL(url);

  if (pathname === "/graphql") {
    const { query } = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    if (!query?.includes("ListReviewThreads")) return readOnly();
    const byId = new Map(REVIEW_COMMENTS.map((c) => [c.id, c]));
    const nodes = THREADS.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      comments: {
        nodes: t.ids.map((id) => ({ databaseId: id, body: byId.get(id)!.body })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }));
    return json(200, {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    });
  }

  if (method !== "GET") return readOnly();

  const repo = `/repos/${PREVIEW_REF.owner}/${PREVIEW_REF.repo}`;
  const pull = `${repo}/pulls/${PREVIEW_REF.number}`;
  switch (pathname) {
    case "/user":
      return json(200, REVIEWER);
    case repo:
      return json(200, { permissions: { push: true } });
    case pull:
      return json(200, {
        number: PREVIEW_REF.number,
        title: "Design: offline sync for the mobile client",
        body: "Proposes a local-first write path with an outbox and background reconciliation.",
        state: "open",
        draft: false,
        merged: false,
        head: {
          sha: HEAD_SHA,
          ref: "design/offline-sync",
          repo: { name: PREVIEW_REF.repo, owner: { login: PREVIEW_REF.owner } },
        },
        base: { ref: "main" },
        user: AUTHOR,
      });
    case `${pull}/files`:
      return json(
        200,
        Object.entries(FILES).map(([filename, source]) => ({
          filename,
          status: "added",
          patch: addedPatch(source),
        })),
      );
    case `${pull}/comments`:
      return json(200, REVIEW_COMMENTS);
    case `/repos/${PREVIEW_REF.owner}/${PREVIEW_REF.repo}/issues/${PREVIEW_REF.number}/comments`:
      return json(200, []);
  }

  const contentsPrefix = `${repo}/contents/`;
  if (pathname.startsWith(contentsPrefix) && searchParams.get("ref") === HEAD_SHA) {
    const source = FILES[decodeURIComponent(pathname.slice(contentsPrefix.length))];
    if (source !== undefined) return json(200, { content: base64(source), encoding: "base64" });
  }
  return json(404, { message: "Not Found (Bark preview fixture)" });
}

function readOnly(): Response {
  return json(403, { message: "Bark preview is read-only: nothing is sent to GitHub." });
}
