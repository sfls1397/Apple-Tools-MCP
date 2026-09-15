/**
 * Shared LanceDB table cache for the vector index.
 *
 * MCP stdio and the indexer daemon are separate processes. The daemon keeps a
 * writer connection for its lifetime. A short-lived MCP reader must still see
 * on-disk emails/messages/calendar tables — including when the first connect
 * listed an empty catalog (writer commit in flight, stale snapshot, or a
 * concurrent initDB that returned before openTable finished).
 *
 * Default LanceDB consistency does not re-check other processes. Readers pass
 * readConsistencyInterval: 0 so tableNames()/openTable() see committed catalog.
 */

import fs from "fs";
import path from "path";

export const INDEX_TABLE_NAMES = ["emails", "messages", "calendar"];

/** Strong cross-process read freshness (seconds). 0 = check on every read. */
export const LANCE_READ_CONSISTENCY_INTERVAL = 0;

export const LANCE_CONNECT_OPTIONS = {
  readConsistencyInterval: LANCE_READ_CONSISTENCY_INTERVAL
};

/**
 * LanceDB stores each table as `<name>.lance` under the index directory.
 *
 * @param {string} indexDir
 * @param {string} name
 * @param {(p: string) => boolean} [existsSync]
 * @returns {boolean}
 */
export function lanceTableExistsOnDisk(indexDir, name, existsSync = fs.existsSync) {
  if (!indexDir || !name) {
    return false;
  }
  try {
    return existsSync(path.join(indexDir, `${name}.lance`));
  } catch {
    return false;
  }
}

/**
 * Open any INDEX_TABLE_NAMES entries not already in `tables`.
 * Always re-lists tableNames — never assume a prior empty catalog is final.
 *
 * @param {{
 *   db: { tableNames: () => Promise<string[]>, openTable: (name: string) => Promise<unknown>, close?: () => void },
 *   tables: Record<string, unknown>,
 *   indexDir: string,
 *   existsSync?: (p: string) => boolean,
 *   reconnect?: () => Promise<{ tableNames: () => Promise<string[]>, openTable: (name: string) => Promise<unknown>, close?: () => void }>,
 *   log?: (msg: string) => void
 * }} args
 * @returns {Promise<{ db: object, tables: Record<string, unknown>, reconnected: boolean }>}
 */
export async function openMissingIndexTables({
  db,
  tables,
  indexDir,
  existsSync = fs.existsSync,
  reconnect,
  log = (msg) => console.error(msg)
}) {
  const missing = INDEX_TABLE_NAMES.filter((name) => tables[name] == null);
  if (missing.length === 0) {
    return { db, tables, reconnected: false };
  }

  let tableNames = [];
  try {
    tableNames = await db.tableNames();
  } catch (e) {
    log(`Failed to list index tables: ${e.message}`);
    return { db, tables, reconnected: false };
  }

  const listed = new Set(tableNames);
  const onDiskButUnlisted = missing.filter(
    (name) => !listed.has(name) && lanceTableExistsOnDisk(indexDir, name, existsSync)
  );

  let reconnected = false;
  let conn = db;
  if (onDiskButUnlisted.length > 0 && typeof reconnect === "function") {
    log("Index catalog missed on-disk tables; reconnecting to shared vector-index.");
    for (const name of INDEX_TABLE_NAMES) {
      delete tables[name];
    }
    try {
      conn = await reconnect();
      reconnected = true;
      tableNames = await conn.tableNames();
    } catch (e) {
      log(`Failed to reconnect to index: ${e.message}`);
      return { db: conn, tables, reconnected };
    }
  }

  const stillMissing = INDEX_TABLE_NAMES.filter((name) => tables[name] == null);
  for (const name of stillMissing) {
    if (!tableNames.includes(name)) {
      continue;
    }
    try {
      tables[name] = await conn.openTable(name);
    } catch (e) {
      log(`Failed to open ${name} table: ${e.message}`);
    }
  }

  return { db: conn, tables, reconnected };
}

/**
 * Process-local LanceDB connection + table handles.
 * `tables` is a stable object (reset deletes keys, does not replace the object)
 * so indexer.js can alias it for createTable/dropTable mutation.
 *
 * @param {{
 *   connect: (uri: string, options: object) => Promise<object>,
 *   indexDir: string,
 *   mkdirSync?: (p: string, opts?: object) => void,
 *   existsSync?: (p: string) => boolean,
 *   log?: (msg: string) => void,
 *   connectOptions?: object
 * }} options
 */
export function createLanceTableCache(options) {
  const {
    connect,
    indexDir,
    mkdirSync,
    existsSync = fs.existsSync,
    log = (msg) => console.error(msg),
    connectOptions = LANCE_CONNECT_OPTIONS
  } = options;

  const tables = {};
  let db = null;
  let connecting = null;

  async function ensureDb() {
    if (db) {
      return db;
    }
    if (!connecting) {
      connecting = (async () => {
        if (typeof mkdirSync === "function") {
          mkdirSync(indexDir, { recursive: true });
        }
        db = await connect(indexDir, connectOptions);
        return db;
      })().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  async function initDB() {
    await ensureDb();
    const result = await openMissingIndexTables({
      db,
      tables,
      indexDir,
      existsSync,
      log,
      reconnect: async () => {
        try {
          db?.close?.();
        } catch {
          // ignore close errors on a stale handle
        }
        db = null;
        return ensureDb();
      }
    });
    db = result.db;
    return { db, tables };
  }

  async function isIndexReady(type = "emails") {
    await initDB();
    return tables[type] != null;
  }

  async function getOpenTable(type) {
    await initDB();
    return tables[type] || null;
  }

  function reset() {
    try {
      db?.close?.();
    } catch {
      // ignore
    }
    db = null;
    connecting = null;
    for (const key of Object.keys(tables)) {
      delete tables[key];
    }
  }

  return {
    initDB,
    isIndexReady,
    getOpenTable,
    reset,
    get db() {
      return db;
    },
    set db(value) {
      db = value;
    },
    tables
  };
}
