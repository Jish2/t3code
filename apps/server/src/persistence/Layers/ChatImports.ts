import type {
  ChatImportDetail,
  ChatImportEntry,
  ChatImportId,
  ChatImportListResult,
  ChatImportSourceKind,
  ChatImportSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ChatImportRepository,
  type ChatImportRepositoryShape,
  type ChatImportSourceRecord,
  type UpsertChatImportSnapshot,
} from "../Services/ChatImports.ts";

interface SummaryRow {
  readonly id: string;
  readonly source: "cursor";
  readonly externalId: string;
  readonly projectKey: string;
  readonly title: string;
  readonly status: "inbox" | "library" | "archived";
  readonly sourceUpdatedAt: string;
  readonly firstSeenAt: string;
  readonly lastSyncedAt: string;
  readonly sourceAvailable: number;
  readonly syncError: string | null;
  readonly entryCount: number;
  readonly linkedThreadId: string | null;
}

interface SourceRow extends SummaryRow {
  readonly sourceKey: string;
  readonly sourcePath: string;
  readonly sourceMtimeMs: number;
  readonly sourceSize: number;
  readonly contentDigest: string;
}

function toSummary(row: SummaryRow): ChatImportSummary {
  return {
    id: row.id as ChatImportId,
    source: row.source,
    externalId: row.externalId,
    projectKey: row.projectKey,
    title: row.title,
    status: row.status,
    sourceUpdatedAt: row.sourceUpdatedAt,
    firstSeenAt: row.firstSeenAt,
    lastSyncedAt: row.lastSyncedAt,
    sourceAvailable: row.sourceAvailable === 1,
    syncError: row.syncError,
    entryCount: row.entryCount,
    linkedThreadId: row.linkedThreadId as ChatImportSummary["linkedThreadId"],
  };
}

function toSourceRecord(row: SourceRow): ChatImportSourceRecord {
  return {
    ...toSummary(row),
    sourceKey: row.sourceKey,
    sourcePath: row.sourcePath,
    sourceMtimeMs: row.sourceMtimeMs,
    sourceSize: row.sourceSize,
    contentDigest: row.contentDigest,
  };
}

const makeChatImportRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getSummary = (id: ChatImportId) =>
    sql<SummaryRow>`
      SELECT
        import_id AS id,
        source_kind AS source,
        external_id AS externalId,
        project_key AS projectKey,
        title,
        status,
        source_updated_at AS sourceUpdatedAt,
        first_seen_at AS firstSeenAt,
        last_synced_at AS lastSyncedAt,
        source_available AS sourceAvailable,
        sync_error AS syncError,
        entry_count AS entryCount,
        linked_thread_id AS linkedThreadId
      FROM chat_imports
      WHERE import_id = ${id}
      LIMIT 1
    `.pipe(
      Effect.map(
        (rows): Option.Option<SummaryRow> => (rows[0] ? Option.some(rows[0]) : Option.none()),
      ),
    );

  const getSourceRecord = (source: ChatImportSourceKind, sourceKey: string) =>
    sql<SourceRow>`
      SELECT
        import_id AS id,
        source_kind AS source,
        source_key AS sourceKey,
        external_id AS externalId,
        project_key AS projectKey,
        source_path AS sourcePath,
        title,
        status,
        source_updated_at AS sourceUpdatedAt,
        first_seen_at AS firstSeenAt,
        last_synced_at AS lastSyncedAt,
        source_available AS sourceAvailable,
        sync_error AS syncError,
        entry_count AS entryCount,
        source_mtime_ms AS sourceMtimeMs,
        source_size AS sourceSize,
        content_digest AS contentDigest,
        linked_thread_id AS linkedThreadId
      FROM chat_imports
      WHERE source_kind = ${source} AND source_key = ${sourceKey}
      LIMIT 1
    `.pipe(
      Effect.map(
        (rows): Option.Option<SourceRow> => (rows[0] ? Option.some(rows[0]) : Option.none()),
      ),
    );

  const replaceEntries = (id: ChatImportId, entries: ReadonlyArray<ChatImportEntry>) =>
    sql`DELETE FROM chat_import_entries WHERE import_id = ${id}`.pipe(
      Effect.flatMap(() =>
        Effect.forEach(
          entries,
          (entry) =>
            sql`
              INSERT INTO chat_import_entries (import_id, ordinal, entry_json)
              VALUES (${id}, ${entry.ordinal}, ${JSON.stringify(entry)})
            `,
          { discard: true },
        ),
      ),
    );

  const upsertSnapshot = (input: UpsertChatImportSnapshot) =>
    Effect.gen(function* () {
      const existing = Option.getOrNull(yield* getSourceRecord(input.source, input.sourceKey));
      const contentChanged = existing === null || existing.contentDigest !== input.contentDigest;
      const metadataChanged =
        existing === null ||
        existing.externalId !== input.externalId ||
        existing.projectKey !== input.projectKey ||
        existing.sourcePath !== input.sourcePath ||
        existing.title !== input.title ||
        existing.sourceUpdatedAt !== input.sourceUpdatedAt ||
        existing.sourceMtimeMs !== input.sourceMtimeMs ||
        existing.sourceSize !== input.sourceSize ||
        existing.linkedThreadId !== input.linkedThreadId ||
        existing.sourceAvailable !== 1 ||
        existing.syncError !== null;
      const change =
        existing === null
          ? ("discovered" as const)
          : contentChanged || metadataChanged
            ? ("updated" as const)
            : ("unchanged" as const);
      const id = (existing?.id as ChatImportId | undefined) ?? input.id;

      if (existing === null) {
        yield* sql`
          INSERT INTO chat_imports (
            import_id, source_kind, source_key, external_id, project_key, source_path,
            title, status, status_updated_at, source_updated_at, first_seen_at,
            last_synced_at, source_available, sync_error, entry_count,
            source_mtime_ms, source_size, content_digest, linked_thread_id
          )
          VALUES (
            ${id}, ${input.source}, ${input.sourceKey}, ${input.externalId}, ${input.projectKey},
            ${input.sourcePath}, ${input.title}, ${"inbox"}, ${input.firstSeenAt},
            ${input.sourceUpdatedAt}, ${input.firstSeenAt}, ${input.lastSyncedAt}, ${1}, ${null},
            ${input.entries.length}, ${input.sourceMtimeMs}, ${input.sourceSize},
            ${input.contentDigest}, ${input.linkedThreadId}
          )
        `;
      } else {
        yield* sql`
          UPDATE chat_imports
          SET
            external_id = ${input.externalId},
            project_key = ${input.projectKey},
            source_path = ${input.sourcePath},
            title = ${input.title},
            source_updated_at = ${input.sourceUpdatedAt},
            last_synced_at = ${input.lastSyncedAt},
            source_available = ${1},
            sync_error = ${null},
            entry_count = ${input.entries.length},
            source_mtime_ms = ${input.sourceMtimeMs},
            source_size = ${input.sourceSize},
            content_digest = ${input.contentDigest},
            linked_thread_id = ${input.linkedThreadId}
          WHERE import_id = ${id}
        `;
      }
      if (contentChanged) {
        yield* replaceEntries(id, input.entries);
      }
      const row = Option.getOrThrow(yield* getSummary(id));
      return { change, summary: toSummary(row) };
    }).pipe(sql.withTransaction);

  const getById: ChatImportRepositoryShape["getById"] = (id) =>
    getSummary(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<ChatImportDetail>()),
          onSome: (summaryRow) =>
            sql<{ readonly entryJson: string }>`
              SELECT entry_json AS entryJson
              FROM chat_import_entries
              WHERE import_id = ${id}
              ORDER BY ordinal ASC
            `.pipe(
              Effect.map((rows) =>
                Option.some({
                  ...toSummary(summaryRow),
                  entries: rows.map((row) => JSON.parse(row.entryJson) as ChatImportEntry),
                }),
              ),
            ),
        }),
      ),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.getById:query")),
    );

  const list: ChatImportRepositoryShape["list"] = (input) => {
    const offset = input.cursor ?? 0;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const status = input.status ?? null;
    const search = input.search?.trim() ?? "";
    const searchPattern = `%${search}%`;

    return Effect.all({
      rows: sql<SummaryRow>`
        SELECT
          import_id AS id,
          source_kind AS source,
          external_id AS externalId,
          project_key AS projectKey,
          title,
          status,
          source_updated_at AS sourceUpdatedAt,
          first_seen_at AS firstSeenAt,
          last_synced_at AS lastSyncedAt,
          source_available AS sourceAvailable,
          sync_error AS syncError,
          entry_count AS entryCount,
          linked_thread_id AS linkedThreadId
        FROM chat_imports
        WHERE linked_thread_id IS NULL
          AND (${status} IS NULL OR status = ${status})
          AND (
            ${search} = ''
            OR title LIKE ${searchPattern}
            OR project_key LIKE ${searchPattern}
          )
        ORDER BY source_updated_at DESC, import_id ASC
        LIMIT ${limit + 1} OFFSET ${offset}
      `,
      counts: sql<{
        readonly inbox: number;
        readonly library: number;
        readonly archived: number;
      }>`
        SELECT
          SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
          SUM(CASE WHEN status = 'library' THEN 1 ELSE 0 END) AS library,
          SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
        FROM chat_imports
        WHERE linked_thread_id IS NULL
      `,
    }).pipe(
      Effect.map(({ rows, counts }) => {
        const count = counts[0] ?? { inbox: 0, library: 0, archived: 0 };
        return {
          items: rows.slice(0, limit).map(toSummary),
          nextCursor: rows.length > limit ? offset + limit : null,
          counts: {
            inbox: Number(count.inbox ?? 0),
            library: Number(count.library ?? 0),
            archived: Number(count.archived ?? 0),
          },
        } satisfies ChatImportListResult;
      }),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.list:query")),
    );
  };

  const listSourceRecords: ChatImportRepositoryShape["listSourceRecords"] = (source) =>
    sql<SourceRow>`
      SELECT
        import_id AS id,
        source_kind AS source,
        source_key AS sourceKey,
        external_id AS externalId,
        project_key AS projectKey,
        source_path AS sourcePath,
        title,
        status,
        source_updated_at AS sourceUpdatedAt,
        first_seen_at AS firstSeenAt,
        last_synced_at AS lastSyncedAt,
        source_available AS sourceAvailable,
        sync_error AS syncError,
        entry_count AS entryCount,
        source_mtime_ms AS sourceMtimeMs,
        source_size AS sourceSize,
        content_digest AS contentDigest,
        linked_thread_id AS linkedThreadId
      FROM chat_imports
      WHERE source_kind = ${source}
    `.pipe(
      Effect.map((rows) => rows.map(toSourceRecord)),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.listSourceRecords:query")),
    );

  const setStatus: ChatImportRepositoryShape["setStatus"] = (input) =>
    sql`
      UPDATE chat_imports
      SET status = ${input.status}, status_updated_at = ${input.updatedAt}
      WHERE import_id = ${input.id} AND linked_thread_id IS NULL
    `.pipe(
      Effect.flatMap(() => getSummary(input.id)),
      Effect.map(Option.map(toSummary)),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.setStatus:query")),
    );

  const markUnavailable: ChatImportRepositoryShape["markUnavailable"] = (input) =>
    sql`
      UPDATE chat_imports
      SET source_available = ${0}, sync_error = ${input.syncError},
          last_synced_at = ${input.lastSyncedAt}
      WHERE import_id = ${input.id}
    `.pipe(
      Effect.flatMap(() => getSummary(input.id)),
      Effect.map(Option.map(toSummary)),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.markUnavailable:query")),
    );

  const markSyncError: ChatImportRepositoryShape["markSyncError"] = (input) =>
    sql`
      UPDATE chat_imports
      SET sync_error = ${input.syncError}, last_synced_at = ${input.lastSyncedAt}
      WHERE import_id = ${input.id}
    `.pipe(
      Effect.flatMap(() => getSummary(input.id)),
      Effect.map(Option.map(toSummary)),
      Effect.mapError(toPersistenceSqlError("ChatImportRepository.markSyncError:query")),
    );

  return {
    upsertSnapshot: (input) =>
      upsertSnapshot(input).pipe(
        Effect.mapError(toPersistenceSqlError("ChatImportRepository.upsertSnapshot:query")),
      ),
    getById,
    list,
    listSourceRecords,
    setStatus,
    markUnavailable,
    markSyncError,
  } satisfies ChatImportRepositoryShape;
});

export const ChatImportRepositoryLive = Layer.effect(
  ChatImportRepository,
  makeChatImportRepository,
);
