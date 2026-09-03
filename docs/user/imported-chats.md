# Imported Cursor chats

T3 finds chats created by Cursor and adds them to the imported chat Inbox. Cursor remains the source of their existing messages until you continue a chat in T3.

Use **Keep** to move an Inbox chat into the Library. Use **Archive** to remove an Inbox or Library chat from the active lists. Restoring an archived chat moves it to the Library.

Moving a chat does not stop synchronization. If a conversation continues in Cursor, its imported copy receives the new messages without changing its Inbox, Library, or Archived state.

## Live sync

The Inbox prompts you before installing Cursor live sync. Enabling it adds two entries to your user-level `~/.cursor/hooks.json` file while preserving your other hooks. Cursor then notifies T3 when a prompt starts and when the response stops. The hook writes notifications to a local durable queue, so changes are reconciled after T3 restarts too. Use **Disable** in the live sync status row to remove T3's hook entries without changing your other Cursor hooks.

T3 also discovers chats at startup, watches changed transcript paths, and runs an infrequent safety scan. It does not repeatedly read every transcript.

## Continue a chat

Send a message from an imported chat to turn it into a normal T3 thread. T3 copies completed messages and tool activity into the thread, resumes the same Cursor conversation, and sends your message. The imported copy disappears from the Inbox because the native thread now represents it. Historical file diffs are unavailable, but later T3 turns keep their normal checkpoints and diffs.

Cursor and T3 can continue the same conversation. Before T3 sends, it refreshes the Cursor transcript and waits if Cursor is responding. After a T3 response finishes, T3 releases the Cursor session so Cursor can use it again.

If both applications send at effectively the same time, T3 stops rather than guessing how to merge conflicting history. Your message remains unsent and the chat reports the conflict. **Keep T3** detaches the native thread from the shared Cursor session. **Accept Cursor** creates a replacement native thread from the current Cursor transcript and continues sharing that session.

The import views combine chats from every connected environment that supports imports. A chat remains available from its last synchronized copy if its original Cursor transcript disappears.
