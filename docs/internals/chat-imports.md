# Chat imports

Chat imports are a read-only catalog for conversations owned by external providers. They are separate from orchestration threads because imported history can change without a T3 command or event, and opening an import must not create or resume a provider session.

## Identity and lifecycle

The Cursor source scans parent transcripts under each Cursor project bucket and excludes subagent transcripts. A source identity combines the project bucket with the transcript-relative path, then hashes that key into a stable import ID. Cursor UUIDs alone are not globally unique across project buckets.

T3 stores Inbox, Library, and Archived as local lifecycle state. Source reconciliation updates mirrored content and availability without changing that state. Missing or malformed source files preserve the last good mirror.

Native T3 Cursor sessions are linked by the persisted Cursor resume session ID. Linked imports stay synchronized but do not appear in imported-chat lists, which avoids displaying the same conversation as both a thread and an import.

## Synchronization

The server performs an initial reconciliation, listens for recursive filesystem changes where the platform supports them, and runs a periodic fallback reconciliation. File size and modification time avoid unnecessary reads. Changed files are parsed and hashed before their entries are replaced transactionally.

Each environment owns its catalog and publishes summary changes over its WebSocket RPC connection. Clients gate import requests on the environment capability, combine summaries across connected environments, and fetch full entries only when a detail view opens.
