# Mermaid samples

A grab-bag of Mermaid diagram types for verifying preview rendering in Bark.
Open this file in **Preview**: each `mermaid` block should render as a diagram,
and clicking into a block should reveal its source for editing.

## Flowchart

```mermaid
flowchart LR
  A[Open PR] --> B{Reviewer?}
  B -->|yes| C[Comment / Suggest]
  B -->|no| D[Edit & Commit]
  C --> E[Submit review]
  D --> E
  E --> F((Done))
```

## Sequence diagram

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant E as Extension
  participant G as GitHub API
  U->>E: Open in Bark
  E->>G: GET /pulls/:n/files
  G-->>E: changed .md files
  E-->>U: rendered review
  U->>E: Submit review
  E->>G: POST /pulls/:n/reviews
  G-->>E: 200 OK
```

## Class diagram

```mermaid
classDiagram
  class ReviewThread {
    +string id
    +ThreadMessage[] messages
    +boolean hasPending
  }
  class ExistingComment {
    +number id
    +string author
    +CommentMetadata meta
  }
  ReviewThread "1" o-- "many" ExistingComment
```

## State diagram

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Submitted: Submit review
  Submitted --> Addressed: author commits
  Addressed --> Resolved
  Resolved --> [*]
```

## Entity-relationship diagram

```mermaid
erDiagram
  PULL_REQUEST ||--o{ REVIEW : has
  REVIEW ||--o{ COMMENT : contains
  COMMENT }o--|| AUTHOR : "written by"
  PULL_REQUEST {
    int number
    string title
  }
```

## Gantt chart

```mermaid
gantt
  title Bark roadmap
  dateFormat YYYY-MM-DD
  section Auth
  Device flow        :done,    a1, 2026-06-01, 3d
  Install gate       :done,    a2, after a1, 2d
  section Review UI
  Design refinement  :active,  b1, 2026-06-10, 4d
  Mermaid support    :         b2, after b1, 2d
```

## Pie chart

```mermaid
pie title Pending items
  "Comments" : 5
  "Suggestions" : 3
  "Replies" : 2
```

## Git graph

```mermaid
gitGraph
  commit id: "init"
  branch feature
  checkout feature
  commit id: "work"
  commit id: "review fixes"
  checkout main
  merge feature
```

## User journey

```mermaid
journey
  title Reviewing a PR in Bark
  section Open
    Click Open in Bark: 5: Reviewer
    Authorize: 3: Reviewer
  section Review
    Comment on text: 5: Reviewer
    Submit review: 4: Reviewer
```

## Mindmap

```mermaid
mindmap
  root((Bark))
    Auth
      Device flow
      Install gate
    Review
      Comments
      Suggestions
      Mermaid
```

## Timeline

```mermaid
timeline
  title Release history
  v0.1 : PAT auth : Single file review
  v0.2 : Device flow : Install gate
  v0.3 : UI refinement : Mermaid preview
```

## Invalid diagram (error handling)

This block is intentionally broken — it should render an inline error message,
not crash the surrounding preview.

```mermaid
flowchart LR
  A --> : this is not valid
  B --[oops]
```

## Mixed content

Regular Markdown around diagrams must still render: **bold**, _italic_,
`inline code`, and a [link](https://example.com).

A non-mermaid code block should stay as code (not a diagram):

```ts
function hello(name: string) {
  return `Hello, ${name}!`;
}
```

The end.
