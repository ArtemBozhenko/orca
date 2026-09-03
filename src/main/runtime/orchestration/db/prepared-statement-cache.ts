import type Database from '../../../sqlite/sync-database'

// Why: SyncDatabase deliberately refuses to cache any `SELECT *` (node:sqlite can build the first
// row after a schema change from stale column names), so orchestration's wildcard reads recompile
// their SQL on every call — and the graph publish runs that fan-out once per pane. Orchestration
// DDL only runs in the OrchestrationDb constructor (createTables/migrate/trigger) and resets are
// DELETE-only, so a connection's column shape is frozen before the first read.
const statementsByDatabase = new WeakMap<Database.Database, Map<string, Database.Statement>>()

/**
 * Compile `sql` once per open connection. Keyed by Database instance, so a reopened database
 * starts empty and never serves a statement bound to the previous connection.
 *
 * Only for read statements with fixed SQL text. Never for DDL, dynamic `IN (?,?,…)` arities, or
 * statements passed to `.iterate()` (better-sqlite3/node:sqlite reject re-entrant iteration).
 */
export function prepareCachedOrchestrationRead(
  db: Database.Database,
  sql: string
): Database.Statement {
  let statements = statementsByDatabase.get(db)
  if (!statements) {
    statements = new Map()
    statementsByDatabase.set(db, statements)
  }
  const cached = statements.get(sql)
  if (cached) {
    return cached
  }
  const statement = db.prepare(sql)
  statements.set(sql, statement)
  return statement
}
