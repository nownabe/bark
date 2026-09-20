// Paginated listing of a PR's review threads via GraphQL.
//
// GitHub caps every GraphQL connection at 100 nodes per page, so both the
// outer `reviewThreads` connection and each thread's nested `comments`
// connection must follow `pageInfo.hasNextPage` / `endCursor` (issue #178).
// This helper hides that behind a flat "every thread with every comment"
// result shared by the RemoteFetcher (fetchThreads) and the Transport
// (findCommentMappings).

import { type GitHubClient, ghGraphQL } from "./github-api";
import type { PrRef } from "./types";

export type RawReviewThread = {
  id: string;
  isResolved: boolean;
  comments: Array<{ databaseId: number; body: string }>;
};

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type CommentsConnection = {
  nodes: Array<{ databaseId: number; body: string }>;
  pageInfo?: PageInfo;
};

const LIST_THREADS_QUERY = `
  query ListReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                databaseId
                body
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

type ListThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: CommentsConnection;
        }>;
        pageInfo?: PageInfo;
      };
    };
  };
};

const THREAD_COMMENTS_QUERY = `
  query ListThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          nodes {
            databaseId
            body
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

type ThreadCommentsResponse = {
  node: { comments: CommentsConnection } | null;
};

/** Fetch every review thread of the PR, following the cursor on the outer
 *  `reviewThreads` connection and on each thread's nested `comments`
 *  connection, so no thread (or metadata-bearing comment) is dropped past
 *  the first 100. */
export async function listReviewThreads(
  client: GitHubClient,
  ref: PrRef,
): Promise<RawReviewThread[]> {
  const threads: RawReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const data: ListThreadsResponse = await ghGraphQL<ListThreadsResponse>(
      client,
      LIST_THREADS_QUERY,
      { owner: ref.owner, repo: ref.repo, number: ref.number, cursor },
    );
    const conn = data.repository.pullRequest.reviewThreads;
    for (const node of conn.nodes) {
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        comments: await collectComments(client, node.id, node.comments),
      });
    }
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor !== null);
  return threads;
}

async function collectComments(
  client: GitHubClient,
  threadId: string,
  firstPage: CommentsConnection,
): Promise<RawReviewThread["comments"]> {
  const comments = [...firstPage.nodes];
  let cursor = firstPage.pageInfo?.hasNextPage ? firstPage.pageInfo.endCursor : null;
  while (cursor !== null) {
    const data = await ghGraphQL<ThreadCommentsResponse>(client, THREAD_COMMENTS_QUERY, {
      threadId,
      cursor,
    });
    const conn = data.node?.comments;
    if (!conn) break;
    comments.push(...conn.nodes);
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return comments;
}
