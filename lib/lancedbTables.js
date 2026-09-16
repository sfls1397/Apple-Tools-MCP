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
  if (!indexDir || !INDEX_TABLE_NAMES.includes(name)) {
    return false;
  }
  try {
    const tableDir = path.join(indexDir, `${name}.lance`);
    const resolvedIndex = path.resolve(indexDir);
    const resolvedTable = path.resolve(tableDir);
    if (resolvedTable !== path.join(resolvedIndex, `${name}.lance`)) {
      return false;
    }
    return existsSync(tableDir);
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
 *   isCurrent?: () => boolean,
 *   log?: (msg: string) => void
 * }} args
 * @returns {Promise<{ db: object, tables: Record<string, unknown>, reconnected: boolean, aborted: boolean }>}
 */
export async function openMissingIndexTables({
  db,
  tables,
  indexDir,
  existsSync = fs.existsSync,
  reconnect,
  isCurrent = () => true,
  log = (msg) => console.error(msg)
}) {
  const stillCurrent = () => {
    try {
      return isCurrent() !== false;
    } catch {
      return false;
    }
  };

  const missing = INDEX_TABLE_NAMES.filter((name) => tables[name] == null);
  if (missing.length === 0) {
    return { db, tables, reconnected: false, aborted: false };
  }

  let tableNames = [];
  try {
    tableNames = await db.tableNames();
  } catch (e) {
    log(`Failed to list index tables: ${e.message}`);
    return { db, tables, reconnected: false, aborted: !stillCurrent() };
  }

  if (!stillCurrent()) {
    return { db, tables, reconnected: false, aborted: true };
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
      if (!stillCurrent()) {
        return { db: conn, tables, reconnected, aborted: true };
      }
      tableNames = await conn.tableNames();
    } catch (e) {
      log(`Failed to reconnect to index: ${e.message}`);
      return { db: conn, tables, reconnected, aborted: !stillCurrent() };
    }
  }

  if (!stillCurrent()) {
    return { db: conn, tables, reconnected, aborted: true };
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
    if (!stillCurrent()) {
      return { db: conn, tables, reconnected, aborted: true };
    }
  }

  return { db: conn, tables, reconnected, aborted: false };
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
  let refreshing = null;
  let generation = 0;

  function rememberPromise(getSlot, setSlot, pending) {
    // Store the .finally() chain, not the raw pending. Discarding the derived
    // promise leaves connect() failures as unhandledRejection (index.js exits).
    const tracked = pending.finally(() => {
      if (getSlot() === tracked) {
        setSlot(null);
      }
    });
    setSlot(tracked);
    return tracked;
  }

  async function ensureDb() {
    if (db) {
      return db;
    }
    if (!connecting) {
      const gen = generation;
      rememberPromise(
        () => connecting,
        (value) => {
          connecting = value;
        },
        (async () => {
          if (typeof mkdirSync === "function") {
            mkdirSync(indexDir, { recursive: true });
          }
          const conn = await connect(indexDir, connectOptions);
          if (gen !== generation) {
            try {
              conn?.close?.();
            } catch {
              // stale connect after reset
            }
            return ensureDb();
          }
          db = conn;
          return db;
        })()
      );
    }
    return connecting;
  }

  async function initDB() {
    if (!refreshing) {
      const gen = generation;
      rememberPromise(
        () => refreshing,
        (value) => {
          refreshing = value;
        },
        (async () => {
          await ensureDb();
          if (gen !== generation) {
            return;
          }
          const result = await openMissingIndexTables({
            db,
            tables,
            indexDir,
            existsSync,
            log,
            isCurrent: () => gen === generation,
            reconnect: async () => {
              if (gen !== generation) {
                return ensureDb();
              }
              try {
                db?.close?.();
              } catch {
                // ignore close errors on a stale handle
              }
              if (gen !== generation) {
                return ensureDb();
              }
              db = null;
              return ensureDb();
            }
          });
          if (gen !== generation || result.aborted) {
            return;
          }
          db = result.db;
        })()
      );
    }
    await refreshing;
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
    generation += 1;
    const toClose = db;
    db = null;
    connecting = null;
    refreshing = null;
    for (const key of Object.keys(tables)) {
      delete tables[key];
    }
    try {
      toClose?.close?.();
    } catch {
      // ignore
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
