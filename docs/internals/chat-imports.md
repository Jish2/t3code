# Chat imports

Chat imports begin as a catalog for conversations owned by external providers. Opening an import does not create or resume a provider session. The first message sent from the import adopts it as a normal orchestration thread linked to the original Cursor session.

## Identity and lifecycle

The Cursor source scans parent transcripts under each Cursor project bucket and excludes subagent transcripts. A source identity combines the project bucket with the transcript-relative path, then hashes that key into a stable import ID. Cursor UUIDs alone are not globally unique across project buckets.

T3 stores Inbox, Library, and Archived as local lifecycle state. Source reconciliation updates mirrored content and availability without changing that state. Missing or malformed source files preserve the last good mirror.

Native T3 Cursor sessions are linked by the persisted Cursor resume session ID. Linked imports stay synchronized but do not appear in imported-chat lists, which avoids displaying the same conversation as both a thread and an import.

## Synchronization

The server performs full discovery at startup and a metadata safety scan every 15 minutes. Between those scans, recursive filesystem notifications reconcile only the changed transcript path. File size and modification time avoid unnecessary reads. Changed files are parsed and hashed before their entries are replaced transactionally.

Users can install managed `beforeSubmitPrompt` and `stop` entries in `~/.cursor/hooks.json`. Installation preserves unrelated hooks, replaces older managed commands during repair or upgrade, and can remove only T3's entries. The generated hook bridge atomically writes each payload under the server state directory. The server installs a watcher before draining that spool and deletes an event only after reconciliation acknowledges it. Failed events remain queued and block later events until retry, preserving lifecycle order.

The `beforeSubmitPrompt` event persists the active Cursor generation and marks a source as `cursor-active`. Only a matching `stop` generation clears it, so a delayed stop cannot release a newer Cursor turn. The stop event performs exact-path reconciliation. Workspace roots from hook payloads are stored with the source and help select the project when an import is adopted.

## Adoption and shared sessions

Adoption persists the intended thread link before thread creation so a retry can finish an interrupted adoption without creating a second thread. It stores a Cursor resume cursor and appends completed history through the internal `thread.history.append` command. The decider emits canonical `thread.message-sent` and `thread.activity-appended` events without requesting provider turns. Each imported turn ends with a deterministic `cursor.external-turn.completed` activity and a missing checkpoint record that makes historical diff limitations explicit. Completed transcript turns have stable SHA-256 hashes. Imported command, turn, message, activity, and checkpoint IDs derive from the import identity and turn hash. Turns are dispatched separately so long imports can resume from the synchronized-turn ledger after a partial failure.

Before a linked T3 turn starts, the catalog uses a per-import mutex to serialize reservation with hook processing, refreshes the exact transcript, and checks that synchronized hashes remain a prefix. It waits while Cursor is active or the transcript has an incomplete tail. A successful reservation records the pending T3 message before orchestration dispatch.

When the matching completed transcript turn arrives, its hash is recorded as T3-origin so history is not appended twice. Other completed turns are appended as Cursor-origin history. A prefix mismatch, an unexpected user message while a T3 turn is reserved, or a source validation failure moves the import to `conflict` and blocks further sends. Keeping T3 detaches the old native thread and clears its shared resume binding. Accepting the Cursor tail creates and links a replacement native thread before materializing the current transcript.

The provider runtime marks adopted bindings with `sharedCursorSession: true`. Cursor can report completion before `sendTurn` finishes its persistence work, so the provider service correlates early completion by thread and turn ID. It stops the adapter only after the matching turn is durably marked active, then persists the binding as stopped while retaining the resume cursor.

Each environment owns its catalog and publishes summary changes over its WebSocket RPC connection. Clients gate import requests on the environment capability, combine summaries across connected environments, and fetch full entries only when a detail view opens.
