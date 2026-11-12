#!/usr/bin/env node
/**
 * Read-only smoke test: every mail_search hit must be readable by mail_read.
 *
 * Runs a few semantic searches against the live index and, for each hit,
 * checks what mail_read needs: the File path passes validateEmailPath, the
 * file exists, and its headers parse. A hit whose file is gone means the
 * index holds stale paths (for example after a move to a new Mac); the
 * indexer re-paths those on its next pass.
 *
 * Writes nothing, sends nothing, needs no indexer lock.
 *
 * Usage:
 *   node scripts/smoke-mail-read.js                 # default queries, 10 hits each
 *   node scripts/smoke-mail-read.js --limit=30 "receipt" "meeting"
 *
 * Exit 0 when every hit is readable, 1 when any is not, 2 when there were no hits.
 */

import fs from "fs";
import path from "path";
import { searchEmails } from "../search.js";
import { validateEmailPath, unfoldRfc822Headers } from "../lib/validators.js";

const MAIL_DIR = path.join(process.env.HOME, "Library", "Mail");
const DEFAULT_QUERIES = ["receipt", "meeting", "invoice"];

export function checkReadable(filePath, mailDir = MAIL_DIR) {
  let validated;
  try {
    validated = validateEmailPath(filePath, mailDir);
  } catch (e) {
    return { ok: false, reason: `invalid path: ${e.message}` };
  }
  if (!fs.existsSync(validated)) return { ok: false, reason: "file not found" };
  const head = unfoldRfc822Headers(fs.readFileSync(validated, "utf-8").slice(0, 65536));
  if (!/^(From|Subject):/m.test(head)) return { ok: false, reason: "no From/Subject header" };
  return { ok: true };
}

async function main(argv) {
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) || 10 : 10;
  const queries = argv.filter((a) => !a.startsWith("--"));
  let hits = 0;
  const failures = [];
  for (const query of queries.length ? queries : DEFAULT_QUERIES) {
    const result = await searchEmails(query, { limit });
    const rows = result?.results || [];
    for (const row of rows) {
      hits++;
      const check = checkReadable(row.filePath);
      if (!check.ok) failures.push({ query, filePath: row.filePath, reason: check.reason });
    }
    console.log(`"${query}": ${rows.length} hits`);
  }
  console.log(`mail_search hits checked: ${hits}, unreadable: ${failures.length}`);
  for (const f of failures.slice(0, 10)) console.log(`  FAIL "${f.query}" ${f.reason}: ${f.filePath}`);
  if (hits === 0) return 2;
  return failures.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(e);
    process.exit(1);
  });
}
