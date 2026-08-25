/**
 * Control-ledger schema and migrations.
 *
 * Migrations are idempotent and each one runs inside a single transaction, so
 * a crash mid-upgrade leaves the ledger at the previous version rather than
 * half-applied. Add new work by appending to {@link MIGRATIONS}; never edit a
 * released entry.
 *
 * The ledger stores plugin *control* data: identities, states, provenance, and
 * the semantic payloads needed for verification and replay. It is not a second
 * raw transcript store - DSH session persistence remains canonical for that.
 *
 * @module dsh-hypatia/ledger/migrations
 */

/** @type {ReadonlyArray<{version: number, up: (db: import('node:sqlite').DatabaseSync) => void}>} */
export const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        -- One plugin-owned semantic memory.
        -- payload_json is cleared after successful cleanup; the row survives
        -- as content-free audit metadata.
        CREATE TABLE IF NOT EXISTS memory_record (
          memory_id     TEXT PRIMARY KEY,
          scope         TEXT NOT NULL,
          shelf         TEXT NOT NULL,
          hypatia_name  TEXT NOT NULL UNIQUE,
          kind          TEXT NOT NULL,
          title         TEXT,
          payload_json  TEXT,
          payload_hash  TEXT NOT NULL,
          state         TEXT NOT NULL,
          trust         TEXT NOT NULL DEFAULT 'derived',
          redaction_labels TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );

        -- Exact-scope recall is the hot path: state first, then scope.
        CREATE INDEX IF NOT EXISTS memory_record_recall
          ON memory_record (state, scope, updated_at DESC);

        -- Durable intent for one mutation, keyed by a stable operation ID so a
        -- replay returns the existing receipt instead of writing twice.
        CREATE TABLE IF NOT EXISTS memory_operation (
          operation_id  TEXT PRIMARY KEY,
          memory_id     TEXT NOT NULL,
          verb          TEXT NOT NULL,
          state         TEXT NOT NULL,
          intent_json   TEXT NOT NULL,
          receipt_json  TEXT,
          error_json    TEXT,
          attempts      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memory_record (memory_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS memory_operation_state
          ON memory_operation (state, updated_at);
        CREATE INDEX IF NOT EXISTS memory_operation_memory
          ON memory_operation (memory_id);

        -- Host-observed source facts. Never model-proposed.
        CREATE TABLE IF NOT EXISTS memory_provenance (
          memory_id       TEXT PRIMARY KEY,
          source_identity TEXT NOT NULL,
          session_id      TEXT,
          from_seq        INTEGER NOT NULL DEFAULT 0,
          through_seq     INTEGER NOT NULL DEFAULT 0,
          turn            INTEGER NOT NULL DEFAULT 0,
          provenance_json TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          FOREIGN KEY (memory_id) REFERENCES memory_record (memory_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS memory_provenance_range
          ON memory_provenance (source_identity, from_seq, through_seq);

        -- Exact plugin-created triples, so cleanup never relies on a broad
        -- model-generated relationship query.
        CREATE TABLE IF NOT EXISTS memory_relation (
          memory_id   TEXT NOT NULL,
          subject     TEXT NOT NULL,
          predicate   TEXT NOT NULL,
          object      TEXT NOT NULL,
          state       TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (subject, predicate, object),
          FOREIGN KEY (memory_id) REFERENCES memory_record (memory_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS memory_relation_memory
          ON memory_relation (memory_id, state);

        -- A deletion request. Written before any CLI call so an interrupted
        -- forget still hides the record and still reports honest status.
        CREATE TABLE IF NOT EXISTS memory_tombstone (
          memory_id     TEXT PRIMARY KEY,
          hypatia_name  TEXT NOT NULL,
          shelf         TEXT NOT NULL,
          scope         TEXT NOT NULL,
          cleanup_state TEXT NOT NULL,
          reason        TEXT,
          requested_at  INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_tombstone_cleanup
          ON memory_tombstone (cleanup_state, updated_at);

        -- Durable consumption cursor per source, for resume and reload.
        CREATE TABLE IF NOT EXISTS session_cursor (
          source_identity  TEXT PRIMARY KEY,
          session_id       TEXT,
          parent_session   TEXT,
          seed_length      INTEGER NOT NULL DEFAULT 0,
          last_applied_seq INTEGER NOT NULL DEFAULT 0,
          updated_at       INTEGER NOT NULL
        );

        -- Operations awaiting another attempt.
        CREATE TABLE IF NOT EXISTS retry_queue (
          operation_id    TEXT PRIMARY KEY,
          next_attempt_at INTEGER NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error_json TEXT,
          FOREIGN KEY (operation_id) REFERENCES memory_operation (operation_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS retry_queue_due ON retry_queue (next_attempt_at);

        -- Operations that exhausted retries. Content-free: the error only.
        CREATE TABLE IF NOT EXISTS dead_letter (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL,
          memory_id    TEXT,
          error_json   TEXT NOT NULL,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS dead_letter_operation ON dead_letter (operation_id);
      `)
    },
  },
  {
    version: 2,
    up(db) {
      // `from_seq`/`through_seq` alone cannot identify a compacted source
      // range: DSH's `shadowedRange` is a surface-position span whose `start`
      // may exceed its `end`, and two compactions can share a bounding pair
      // while shadowing different nodes. `source_range_key` carries the digest
      // of the authoritative `shadowedSeqs` set so the dedup lookup is exact.
      db.exec(`
        ALTER TABLE memory_provenance ADD COLUMN source_range_key TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS memory_provenance_range_key
          ON memory_provenance (source_identity, source_range_key);
      `)
    },
  },
]

/** Highest schema version this build knows how to produce. */
export const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Bring `db` up to {@link TARGET_VERSION}.
 *
 * Safe to call on every startup: already-applied versions are skipped, and a
 * ledger created by a newer build is left untouched rather than downgraded.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{from: number, to: number, applied: number[]}}
 */
export function migrate(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // The ledger path is per-user, not per-project, so every concurrent `dsh`
  // process shares this file. `node:sqlite` defaults to a zero busy timeout,
  // which turns a momentary write overlap into `database is locked` thrown
  // straight out of `beginOperation`/`commitReceipt` rather than a short wait.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')

  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get()
  const from = row?.version ?? 0
  const applied = []

  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      db.exec('COMMIT')
      applied.push(migration.version)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return { from, to: Math.max(from, TARGET_VERSION), applied }
}
