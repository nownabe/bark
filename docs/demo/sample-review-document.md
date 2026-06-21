# Fieldnote — Offline Sync

Notes are saved **locally first**, then synced to the server when the device is
back online — so a dropped connection never loses work.

## Status

| Area     | State        | Owner    |
| -------- | ------------ | -------- |
| Queue    | ✅ Done      | Platform |
| Ordering | 🚧 In review | Server   |
| Rollout  | ⏳ Planned   | Mobile   |

## Sync flow

```mermaid
flowchart LR
    A[Edit note] --> B[Local store]
    B --> C{Online?}
    C -- Yes --> D[Sync to server]
    C -- No --> B
    D --> E{Conflict?}
    E -- No --> F[Synced]
    E -- Yes --> G[Keep both]
```

## Design notes

- Edits are flushed to the server in the backround by a worker.
- We cap the local queue at 500 edits per device.

```ts
async function enqueueEdit(edit: QueuedEdit) {
  await localStore.append("pending", edit);
  scheduler.wake();
}
```

> On conflict, Fieldnote keeps **both** versions instead of dropping an edit.
