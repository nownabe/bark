// Executor — runs ExecutionSteps against a Transport and returns per-step
// outcomes the Repository can use to advance entity state.
//
// The Executor itself is intentionally thin: it dispatches by step kind to
// the matching Transport method and pairs each step with its outcome.
// Batching / planning lives in the Planner; API knowledge lives in the
// Transport. The Executor just orchestrates.
//
// See docs/adr/0003-operations-and-execution.md §3.

import type { ExecutionStep } from "./steps";
import type {
  CommitOutcome,
  PostIssueCommentOutcome,
  PostReplyOutcome,
  PostReviewBatchOutcome,
  ResolveOutcome,
  Transport,
} from "./transport";

export type StepResult =
  | { step: Extract<ExecutionStep, { kind: "post-review-batch" }>; outcome: PostReviewBatchOutcome }
  | { step: Extract<ExecutionStep, { kind: "post-reply" }>; outcome: PostReplyOutcome }
  | {
      step: Extract<ExecutionStep, { kind: "post-issue-comment" }>;
      outcome: PostIssueCommentOutcome;
    }
  | { step: Extract<ExecutionStep, { kind: "resolve-review-thread" }>; outcome: ResolveOutcome }
  | { step: Extract<ExecutionStep, { kind: "unresolve-review-thread" }>; outcome: ResolveOutcome }
  | { step: Extract<ExecutionStep, { kind: "commit" }>; outcome: CommitOutcome };

/** Run all steps sequentially against the transport and collect their outcomes.
 *  Steps within a cycle are independent at the state-machine level, but
 *  running them sequentially keeps GitHub-side rate-limiting and ordering
 *  simple. A future optimisation may parallelise the safe subset. */
export async function execute(steps: ExecutionStep[], transport: Transport): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    results.push(await runStep(step, transport));
  }
  return results;
}

async function runStep(step: ExecutionStep, transport: Transport): Promise<StepResult> {
  switch (step.kind) {
    case "post-review-batch":
      return { step, outcome: await transport.postReviewBatch(step) };
    case "post-reply":
      return { step, outcome: await transport.postReply(step) };
    case "post-issue-comment":
      return { step, outcome: await transport.postIssueComment(step) };
    case "resolve-review-thread":
      return { step, outcome: await transport.resolveReviewThread(step) };
    case "unresolve-review-thread":
      return { step, outcome: await transport.unresolveReviewThread(step) };
    case "commit":
      return { step, outcome: await transport.commit(step) };
  }
}
