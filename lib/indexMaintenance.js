
export const INDEX_OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const INDEX_OPTIMIZE_KEEP_VERSIONS_MS = 60 * 60 * 1000;

export function createIndexedIdCache({ getTable, log = (msg) => console.error(msg) }) {
  const entries = new Map();

  function emptySets(fields) {
    return Object.fromEntries(fields.map((field) => [field, new Set()]));
  }

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
    has(tableName) {
      return entries.has(tableName);
    }
  };
}

export function createDuplicatePathTracker() {
  const paths = new Set();
  return {
    add(filePath) {
      paths.add(filePath);
    },
    has(filePath) {
      return paths.has(filePath);
    },
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
