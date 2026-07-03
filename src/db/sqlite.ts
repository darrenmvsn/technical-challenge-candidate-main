import Database from 'better-sqlite3'
import { DDL } from './migrations.js'

export type DB = Database.Database

export function openDb(path = ':memory:'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Block-and-retry (up to 5s) instead of throwing SQLITE_BUSY the instant a concurrent
  // BEGIN IMMEDIATE can't take the write lock — load-bearing for lease-claim fencing.
  db.pragma('busy_timeout = 5000')
  return db
}

/** Idempotent — safe to re-run on an existing DB (all DDL uses IF NOT EXISTS). */
export function migrate(db: DB): void {
  db.exec(DDL)
}
