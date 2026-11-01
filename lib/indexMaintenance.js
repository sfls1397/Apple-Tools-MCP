/**
 * Indexer-daemon upkeep that keeps a long-lived process light:
 *
 * - createIndexedIdCache: keeps the indexed ID sets (email filePath and
 *   messageId, message id) in memory between passes and re-reads a table only
 *   when its LanceDB version moved. A quiet pass costs one version check
 *   instead of a full column scan.
 * - createDuplicatePathTracker: remembers email files skipped because their
 *   Message-ID is already indexed (IMAP copies in another folder), so the
 *   same copies are not parsed again every pass.
 * - optimizeIndexTables / isIndexOptimizeDue: periodic LanceDB compaction and
 *   old-version cleanup, run after a pass that wrote something.
 */

export const INDEX_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Keep this much table history when cleaning up old versions. */
export const INDEX_OPTIMIZE_KEEP_VERSIONS_MS = 60 * 60 * 1000;

/**
 * @param {{
 *   getTable: (tableName: string) => Promise<object | null>,
 *   log?: (msg: string) => void
 * }} options
 */
export function createIndexedIdCache({ getTable, log = (msg) => console.error(msg) }) {
  /** @type {Map<string, { table: object, version: number, sets: Record<string, Set<unknown>> }>} */
  const entries = new Map();

  function emptySets(fields) {
    return Object.fromEntries(fields.map((field) => [field, new Set()]));
  }

  /**
   * ID sets for `fields`, read in one query. Served from memory while the
   * table handle and version are unchanged.
   *
   * @param {string} tableName
   * @param {string[]} fields
   * @returns {Promise<Record<string, Set<unknown>>>}
   */
  async function getIdSets(tableName, fields) {
    const table = await getTable(tableName);
    if (!table) {
      entries.delete(tableName);
      return emptySets(fields);
    }
    const version = await table.version();
    const cached = entries.get(tableName);
    if (
      cached &&
      cached.table === table &&
      cached.version === version &&
      fields.every((field) => cached.sets[field])
    ) {
      return cached.sets;
    }
    const rows = await table.query().select(fields).toArray();
    const sets = emptySets(fields);
    for (const row of rows) {
      for (const field of fields) {
        sets[field].add(row[field]);
      }
    }
    entries.set(tableName, { table, version, sets });
    return sets;
  }

  /**
   * Fold rows this process just added into the cached sets. Call right after a
   * table.add() whose ID sets were read with getIdSets just before it. If the
   * table moved by anything other than that one commit (another writer), the
   * entry is dropped and the next getIdSets re-reads.
   *
   * @param {string} tableName
   * @param {object[]} records
   */
  async function noteAdded(tableName, records) {
    const cached = entries.get(tableName);
    if (!cached) {
      return;
    }
    const table = await getTable(tableName);
    let version;
    try {
      version = table ? await table.version() : null;
    } catch (e) {
      log(`Index ID cache: could not read ${tableName} version (${e.message}); will re-read.`);
      entries.delete(tableName);
      return;
    }
    if (table !== cached.table || version !== cached.version + 1) {
      entries.delete(tableName);
      return;
    }
    for (const record of records) {
      for (const field of Object.keys(cached.sets)) {
        if (record[field] !== undefined && record[field] !== null && record[field] !== "") {
          cached.sets[field].add(record[field]);
        }
      }
    }
    cached.version = version;
  }

  function invalidate(tableName) {
    if (tableName === undefined) {
      entries.clear();
    } else {
      entries.delete(tableName);
    }
  }

  return {
    getIdSets,
    noteAdded,
    invalidate,
    /** @returns {boolean} */
    has(tableName) {
      return entries.has(tableName);
    }
  };
}

/**
 * Paths of email files that duplicate an already-indexed Message-ID.
 * retainOnly() drops paths that left the incremental lookback window, so the
 * set stays bounded by the window's duplicates.
 */
export function createDuplicatePathTracker() {
  const paths = new Set();
  return {
    add(filePath) {
      paths.add(filePath);
    },
    has(filePath) {
      return paths.has(filePath);
    },
    /** @param {Iterable<string>} currentPaths */
    retainOnly(currentPaths) {
      const keep = currentPaths instanceof Set ? currentPaths : new Set(currentPaths);
      for (const filePath of paths) {
        if (!keep.has(filePath)) {
          paths.delete(filePath);
        }
      }
    },
    clear() {
      paths.clear();
    },
    get size() {
      return paths.size;
    }
  };
}

/**
 * @param {{ lastOptimizeTime?: number | null, now?: number, wroteSomething: boolean, intervalMs?: number }} args
 */
export function isIndexOptimizeDue({
  lastOptimizeTime,
  now = Date.now(),
  wroteSomething,
  intervalMs = INDEX_OPTIMIZE_INTERVAL_MS
}) {
  if (!wroteSomething) {
    return false;
  }
  if (typeof lastOptimizeTime !== "number" || !Number.isFinite(lastOptimizeTime)) {
    return true;
  }
  if (lastOptimizeTime > now) {
    return true;
  }
  return now - lastOptimizeTime >= intervalMs;
}

/**
 * Compact each open table and remove versions older than keepVersionsMs.
 * Failures are logged per table and never thrown: an index pass must not fail
 * because upkeep did.
 *
 * @param {{
 *   tables: Record<string, { optimize: (opts: object) => Promise<any> } | null | undefined>,
 *   tableNames: string[],
 *   now?: number,
 *   keepVersionsMs?: number,
 *   log?: (msg: string) => void
 * }} args
 * @returns {Promise<{ optimized: string[], failed: string[] }>}
 */
export async function optimizeIndexTables({
  tables,
  tableNames,
  now = Date.now(),
  keepVersionsMs = INDEX_OPTIMIZE_KEEP_VERSIONS_MS,
  log = (msg) => console.error(msg)
}) {
  const optimized = [];
  const failed = [];
  const cleanupOlderThan = new Date(now - keepVersionsMs);
  for (const name of tableNames) {
    const table = tables[name];
    if (!table || typeof table.optimize !== "function") {
      continue;
    }
    const started = Date.now();
    try {
      const stats = await table.optimize({ cleanupOlderThan });
      const c = stats?.compaction || {};
      const p = stats?.prune || {};
      log(
        `Optimized ${name}: fragments -${c.fragmentsRemoved ?? 0} +${c.fragmentsAdded ?? 0}, ` +
          `old versions removed ${p.oldVersionsRemoved ?? 0}, ` +
          `${Math.round(Number(p.bytesRemoved ?? 0) / (1024 * 1024))} MB freed (${Date.now() - started}ms)`
      );
      optimized.push(name);
    } catch (e) {
      log(`Optimize ${name} failed (index still usable): ${e.message}`);
      failed.push(name);
    }
  }
  return { optimized, failed };
}
