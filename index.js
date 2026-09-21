#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { validateEmailPath, stripHtmlTags, unfoldRfc822Headers, validateLimit, validateDaysBack, validateWeekOffset, toUnixMillis } from "./lib/validators.js";
import { cycleEndFlags, indexUnavailableMessage, indexQueryGate } from "./lib/indexGate.js";
import { isIndexerMode, isPermissionsMode } from "./lib/processMode.js";
import { runPermissionsCommand } from "./lib/permissions.js";
import { loadResolvedIndexInterval, logResolvedInterval } from "./lib/config.js";
import { createIndexerLock, DEFAULT_LOCK_HEARTBEAT_MS } from "./lib/indexerLock.js";
import {
  shouldConnectMcpStdio,
  bindStdinCloseExit,
  beginIndexCycle,
  applyIndexerCycleEnd,
  mcpIndexingStartup,
  waitForIndexerLock,
  beginOwnedIndexing
} from "./lib/indexerRuntime.js";
import {
  WRITE_TOOL_DEFINITIONS,
  isWriteTool,
  dispatchWriteTool,
  executeWriteToolLocally
} from "./lib/writeTools.js";
import { startWriteBridgeServer, defaultSocketPath } from "./lib/writeBridge.js";
import { closeEventKitSession, ensureEventKitSession } from "./lib/eventKitSession.js";
import { EVENTKIT_JXA_HELPERS } from "./lib/calendarWrite.js";

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version;

// Canonical indexer entrypoint: `node index.js --mode=indexer` or `apple-tools-indexer`.
// Permissions CLI: `apple-tools-mcp permissions` — short-lived, no MCP / indexer.
const PERMISSIONS_MODE = isPermissionsMode();
const INDEXER_MODE = isIndexerMode();
const resolvedIndexInterval = loadResolvedIndexInterval();
const INDEX_INTERVAL = resolvedIndexInterval.ms;
const LOCK_HEARTBEAT_MS = DEFAULT_LOCK_HEARTBEAT_MS;
const LOCK_RETRY_MS = 5 * 1000;

// Lock file to prevent duplicate indexing processes
const LOCK_FILE = path.join(process.env.HOME, ".apple-tools-mcp", "indexer.lock");
const indexerLock = createIndexerLock({
  lockFile: LOCK_FILE,
  log: (msg) => console.error(msg)
});
// True only while this process won the indexer lock. Distinct from
// sessionIndexComplete: a secondary instance that lost the lock never
// completes a local cycle and must not stay on "still indexing" forever.
let ownsIndexLock = false;

function acquireLock() {
  const ok = indexerLock.acquire();
  ownsIndexLock = indexerLock.ownsLock;
  if (ok) {
    startLockHeartbeat();
  }
  return ok;
}

function releaseLock() {
  indexerLock.release();
  ownsIndexLock = indexerLock.ownsLock;
  if (!ownsIndexLock) {
    stopLockHeartbeat();
  }
}

function startLockHeartbeat() {
  indexerLock.startHeartbeat(LOCK_HEARTBEAT_MS);
}

function stopLockHeartbeat() {
  indexerLock.stopHeartbeat();
}

// Daemon-only: serves writes for stdio clients whose host app cannot be
// granted Contacts/Calendar automation (see lib/writeBridge.js).
const WRITE_SOCKET_PATH = defaultSocketPath();
let writeBridge = null;

function stopWriteBridge() {
  closeEventKitSession();
  if (!writeBridge) return;
  try {
    writeBridge.close();
  } catch (e) {
    console.error("Error closing write bridge:", e.message);
  }
  writeBridge = null;
}

async function startWriteBridge() {
  try {
    writeBridge = await startWriteBridgeServer({
      socketPath: WRITE_SOCKET_PATH,
      handler: (tool, args) => executeWriteToolLocally(tool, args),
      log: (msg) => console.error(msg)
    });
    ensureEventKitSession({ helpers: EVENTKIT_JXA_HELPERS });
  } catch (e) {
    console.error(`Write bridge unavailable: ${e.message}. Writes will run in each MCP process.`);
  }
}

function shutdownIndexing(exitCode) {
  stopBackgroundIndexing();
  stopLockHeartbeat();
  stopWriteBridge();
  releaseLock();
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}

// Clean up lock and timer on exit
process.on("exit", () => {
  stopBackgroundIndexing();
  stopLockHeartbeat();
  stopWriteBridge();
  releaseLock();
});
process.on("SIGINT", () => {
  shutdownIndexing();
  process.exit();
});
process.on("SIGTERM", () => {
  shutdownIndexing();
  process.exit();
});
process.on("SIGHUP", () => {
  shutdownIndexing();
  process.exit();
});

// Handle uncaught errors - cleanup before crashing
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  shutdownIndexing(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
  shutdownIndexing(1);
});

// MCP stdio clients exit when the host closes stdin. The indexer daemon must
// not — LaunchAgent / KeepAlive often attaches stdin to /dev/null.
bindStdinCloseExit(process.stdin, INDEXER_MODE || PERMISSIONS_MODE, () => {
  console.error("Client disconnected. Exiting.");
  shutdownIndexing(0);
});

// Vector search imports
import {
  indexAll,
  isIndexReady,
  rebuildIndex,
  getFrequentSenders,
  getMessageContacts,
  getUpcomingEvents,
  getWeekEvents,
  getEmailThread,
  getRecurringEvents,
  // Contacts functions
  loadContacts,
  searchContacts,
  lookupContact,
  getContactIdentifiers
} from "./indexer.js";
import {
  searchEmails,
  formatEmailResults,
  getRecentEmailResults,
  getEmailDateResults,
  searchMessages,
  formatMessageResults,
  getRecentMessageResults,
  getConversationResults,
  formatConversationResults,
  searchCalendar,
  formatCalendarResults,
  getCalendarDateResults,
  calculateFreeTime,
  formatFreeTimeResults,
  prewarmTables,
  formatSendersResults,
  formatMessageContactsResults,
  formatUpcomingEventsResults,
  formatWeekEventsResults,
  formatEmailThreadResults,
  formatRecurringEventsResults
} from "./search.js";
import {
  auditAll,
  formatAuditReport
} from "./lib/audit.js";

// Track indexing status
let indexingInProgress = false;
let sessionIndexComplete = false;  // Track if this session's indexing is done
let isFirstEverRun = true;  // True if no index exists yet
let lastIndexTime = 0;
let lastProgressTime = 0;  // Track when we last made progress (for hung detection)
let indexTimer = null;
let progressCheckTimer = null;
let loggedIndexInterval = false;

// Check if this is the first ever run (no index exists)
async function checkIfFirstRun() {
  const emailsReady = await isIndexReady("emails");
  const messagesReady = await isIndexReady("messages");
  const calendarReady = await isIndexReady("calendar");
  // If any index exists, this isn't the first run
  return !(emailsReady || messagesReady || calendarReady);
}

// Run a single indexing cycle (called by background timer)
function runIndexCycle() {
  const cycle = beginIndexCycle(indexingInProgress);
  if (!cycle.started) {
    return;
  }
  indexingInProgress = cycle.indexingInProgress;

  // Safety net: check lock before indexing
  if (!acquireLock()) {
    indexingInProgress = false;
    console.error("Another instance is indexing. Skipping.");
    return;
  }

  indexingInProgress = true;
  const startMsg = isFirstEverRun ? "Building initial index..." : "Indexing new data...";
  console.error(startMsg);

  // Initialize progress tracking - we're starting work now
  lastProgressTime = Date.now();

  // Progress-based timeout: Check every minute if we're making progress
  // If no progress for 10 minutes, assume the process is hung
  const PROGRESS_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute
  const MAX_NO_PROGRESS_MS = 10 * 60 * 1000; // Kill if no progress for 10 minutes

  progressCheckTimer = setInterval(() => {
    const timeSinceProgress = Date.now() - lastProgressTime;
    if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
      console.error(`⚠️  No indexing progress for ${Math.round(timeSinceProgress / 60000)} minutes. Indexing still running; not starting another cycle.`);
      clearInterval(progressCheckTimer);
      progressCheckTimer = null;
      // Allow searches, but do NOT clear indexingInProgress or release the lock
      // while indexAll() is still running — overlapping writes can corrupt LanceDB.
      sessionIndexComplete = true;
    }
  }, PROGRESS_CHECK_INTERVAL_MS);

  // Progress callback to track that indexing is making forward progress
  const reportProgress = (stage) => {
    lastProgressTime = Date.now();
    // Progress reported, no need to log each batch
  };

  indexAll(reportProgress)
    .then(async () => {
      // Clear progress monitor
      if (progressCheckTimer) {
        clearInterval(progressCheckTimer);
        progressCheckTimer = null;
      }

      lastIndexTime = Date.now();
      lastProgressTime = Date.now();
      applyCycleEnd(true);
      console.error("Indexing complete.");
      // Pre-warm tables to eliminate first-query latency
      await prewarmTables();
    }).catch(e => {
      // Clear progress monitor
      if (progressCheckTimer) {
        clearInterval(progressCheckTimer);
        progressCheckTimer = null;
      }

      console.error("Indexing error:", e.message);
      applyCycleEnd(false);
    });
}

// DEPRECATED: Legacy function kept for backward compatibility
// New implementation uses background timer instead of on-demand triggering
function triggerIndexIfNeeded() {
  // No-op: indexing now runs on background timer
  // This function is kept to avoid breaking any external dependencies
}

// Start continuous background indexing
function startBackgroundIndexing() {
  if (!loggedIndexInterval) {
    logResolvedInterval(resolvedIndexInterval);
    loggedIndexInterval = true;
  }

  // Run indexing immediately on startup
  runIndexCycle();

  // Then schedule every INDEX_INTERVAL milliseconds
  indexTimer = setInterval(() => {
    runIndexCycle();
  }, INDEX_INTERVAL);

  console.error(`Background indexing started (interval: ${resolvedIndexInterval.human} / ${INDEX_INTERVAL} ms)`);
}

// Stop background indexing and clean up timers
function stopBackgroundIndexing() {
  const wasRunning = Boolean(indexTimer || progressCheckTimer);
  if (indexTimer) {
    clearInterval(indexTimer);
    indexTimer = null;
  }
  if (progressCheckTimer) {
    clearInterval(progressCheckTimer);
    progressCheckTimer = null;
  }
  if (wasRunning) {
    console.error("Background indexing stopped");
  }
}

// Unblock searches after a cycle ends. Must run on failure as well as success
// so tools are not stuck forever. The indexer daemon keeps indexer.lock for
// the process lifetime; MCP local-fallback still releases between cycles.
function applyCycleEnd(success) {
  const result = applyIndexerCycleEnd({
    success,
    indexerMode: INDEXER_MODE,
    cycleEndFlags,
    releaseLock
  });
  indexingInProgress = result.indexingInProgress;
  sessionIndexComplete = result.sessionIndexComplete;
  ownsIndexLock = result.ownsIndexLock;
  if (result.isFirstEverRun === false) {
    isFirstEverRun = false;
  }
}

// Index-backed tools wait only while THIS process owns the lock and has not
// finished its cycle. Lost-lock secondaries fall through to isIndexReady().
function stillIndexingMessage() {
  const gate = indexQueryGate({
    sessionIndexComplete,
    ownsIndexLock,
    indexReady: true,
    isFirstEverRun
  });
  return gate.ok ? null : gate.message;
}

/** Shared preflight for index-backed query tools (on-disk tables, not local cycle). */
async function requireIndex(type) {
  const indexing = stillIndexingMessage();
  if (indexing) {
    return indexing;
  }
  const ready = await isIndexReady(type);
  const gate = indexQueryGate({
    sessionIndexComplete,
    ownsIndexLock,
    indexReady: ready,
    type,
    isFirstEverRun
  });
  return gate.ok ? null : gate.message;
}

function waitForLockAndStartDaemon() {
  waitForIndexerLock(acquireLock, {
    retryMs: LOCK_RETRY_MS,
    onAcquired: () => {
      beginOwnedIndexing({
        startHeartbeat: startLockHeartbeat,
        startBackground: startBackgroundIndexing
      });
    }
  });
}

// Initialize and start indexing
async function initializeIndexing() {
  if (INDEXER_MODE) {
    console.error(`Apple Tools MCP indexer running (v${PACKAGE_VERSION})`);
    logResolvedInterval(resolvedIndexInterval);
    loggedIndexInterval = true;
    // launchd started this process, so node owns its TCC prompts. Offer the
    // write bridge to stdio clients whose host app cannot get those grants.
    // This happens before any index work: writes must stay available even if
    // the vector index is missing, locked, or unreadable.
    await startWriteBridge();
  }

  try {
    isFirstEverRun = await checkIfFirstRun();
  } catch (e) {
    // A failed readiness probe must not take the daemon (or its write
    // bridge) down; assume a first run and let the cycle report the details.
    console.error(`Could not determine index state: ${e.message}`);
    isFirstEverRun = true;
  }

  if (INDEXER_MODE) {
    waitForLockAndStartDaemon();
    return;
  }

  // MCP stdio: if the indexer daemon (or another instance) holds the lock,
  // skip background refresh and use the shared index. If nothing holds the
  // lock, index locally as before so the stdio happy path still works.
  const startup = mcpIndexingStartup(() => acquireLock());
  if (!startup.startBackground) {
    console.error("Another apple-tools-mcp instance is indexing. Server will run without background indexing.");
    // Lost lock is not "still indexing": this process will never complete a
    // local cycle. Searches proceed whenever isIndexReady() is true (initDB
    // re-lists shared on-disk tables; it must not cache an empty first connect).
    ownsIndexLock = false;
    return;
  }

  // Start background indexing (local fallback when no daemon is running)
  // using the same heartbeat path as the daemon so a long first-index cycle
  // cannot look like a stale lock to another waiter.
  beginOwnedIndexing({
    startHeartbeat: startLockHeartbeat,
    startBackground: startBackgroundIndexing
  });
}

// Start indexing immediately on server startup. A startup failure is logged
// rather than rejected: an unhandled rejection would tear down the daemon,
// taking the write bridge with it.
if (PERMISSIONS_MODE) {
  runPermissionsCommand({
    execPath: process.execPath,
    argv: process.argv,
    version: PACKAGE_VERSION
  }).then((code) => {
    process.exit(code);
  }).catch((e) => {
    console.error(`Permissions command error: ${e.message}`);
    process.exit(1);
  });
} else {
  initializeIndexing().catch((e) => {
    console.error(`Indexing startup failed: ${e.message}`);
  });
}

// ============ SEMANTIC SEARCH FUNCTIONS ============

async function mailSearch(query, options = {}) {
  if (!query) {
    return "Error: query parameter is required for mail_search";
  }

  const blocked = await requireIndex("emails");
  if (blocked) {
    return blocked;
  }

  const result = await searchEmails(query, options);
  return formatEmailResults(result);
}

async function mailRecent(limit = 30, daysBack = 7, unreadOnly = false, includeJunk = false) {
  const blocked = await requireIndex("emails");
  if (blocked) {
    return blocked;
  }

  const result = await getRecentEmailResults(limit, daysBack, unreadOnly, includeJunk);
  return formatEmailResults(result);
}

async function mailDate(date, includeJunk = false) {
  const blocked = await requireIndex("emails");
  if (blocked) {
    return blocked;
  }

  const result = await getEmailDateResults(date, includeJunk);
  return formatEmailResults(result);
}

async function messagesSearch(query, options = {}) {
  const blocked = await requireIndex("messages");
  if (blocked) {
    return blocked;
  }

  const result = await searchMessages(query, options);
  return formatMessageResults(result);
}

async function messagesRecent(limit = 10, daysBack = 1) {
  const blocked = await requireIndex("messages");
  if (blocked) {
    return blocked;
  }

  const result = await getRecentMessageResults(limit, daysBack);
  return formatMessageResults(result);
}

async function messagesConversation(contact, limit = 50) {
  const blocked = await requireIndex("messages");
  if (blocked) {
    return blocked;
  }

  const result = await getConversationResults(contact, limit);
  return formatConversationResults(result);
}

async function calendarSearch(query, options = {}) {
  const blocked = await requireIndex("calendar");
  if (blocked) {
    return blocked;
  }

  const result = await searchCalendar(query, options);
  return formatCalendarResults(result);
}

async function calendarDate(date) {
  const result = await getCalendarDateResults(date);
  return formatCalendarResults(result);
}

async function calendarFreeTime(date, options = {}) {
  const result = await calculateFreeTime(date, options);
  return formatFreeTimeResults(result);
}

// Mail directory for path validation
const MAIL_DIR = path.join(process.env.HOME, "Library", "Mail");

// Read full email content from file path
function readFullEmail(filePath) {
  try {
    // Validate file path to prevent path traversal attacks
    let validatedPath;
    try {
      validatedPath = validateEmailPath(filePath, MAIL_DIR);
    } catch (e) {
      return `Invalid file path: ${e.message}. Use a path from mail_search results.`;
    }

    // Verify file exists
    if (!fs.existsSync(validatedPath)) {
      return "Email file not found.";
    }

    const content = unfoldRfc822Headers(fs.readFileSync(validatedPath, 'utf-8'));

    // Parse email headers and body
    const fromMatch = content.match(/^From:\s*(.+)$/m);
    const toMatch = content.match(/^To:\s*(.+)$/m);
    const subjectMatch = content.match(/^Subject:\s*(.+)$/m);
    const dateMatch = content.match(/^Date:\s*(.+)$/m);

    // Find body after headers
    const headerEnd = content.search(/\r?\n\r?\n/);
    let body = headerEnd > 0 ? content.substring(headerEnd + 2) : content;

    // Clean up body - remove HTML if present using safe method
    if (body.includes('<html') || body.includes('<HTML')) {
      // Use safe HTML stripping to prevent ReDoS
      body = stripHtmlTags(body);
      // Decode common HTML entities
      body = body.replace(/&nbsp;/g, ' ');
      body = body.replace(/&amp;/g, '&');
      body = body.replace(/&lt;/g, '<');
      body = body.replace(/&gt;/g, '>');
    }

    return `From: ${fromMatch?.[1]?.trim() || 'Unknown'}
To: ${toMatch?.[1]?.trim() || 'Unknown'}
Subject: ${subjectMatch?.[1]?.trim() || 'No subject'}
Date: ${dateMatch?.[1]?.trim() || 'Unknown'}

${body.substring(0, 10000)}`;
  } catch (error) {
    return `Error reading email: ${error.message}`;
  }
}

// ============ SMART SEARCH (AGENTIC RAG) ============

// Detect which data sources to search based on query intent
function detectSources(query) {
  const q = query.toLowerCase();
  const sources = [];

  // Calendar indicators
  if (/\b(when|schedule|calendar|event|meeting|appointment|today|tomorrow|next \w+day|this week|free time|available|busy)\b/.test(q)) {
    sources.push('calendar');
  }

  // Messages indicators
  if (/\b(said|message|text|chat|conversation|imessage|sms|texted|replied)\b/.test(q)) {
    sources.push('messages');
  }

  // Mail indicators
  if (/\b(email|mail|sent|inbox|from .+ about|subject|attachment|forward|reply)\b/.test(q)) {
    sources.push('mail');
  }

  // Default to all if no clear indicators
  return sources.length > 0 ? sources : ['mail', 'messages', 'calendar'];
}

// Format smart search results from multiple sources
function formatSmartSearchResults(results, synthesizedGroups = null) {
  const sections = [];

  // If we have synthesized timeline groups, show those first
  if (synthesizedGroups && synthesizedGroups.length > 0) {
    sections.push("=== Timeline View (Related Items Grouped) ===\n");
    for (const group of synthesizedGroups.slice(0, 5)) {
      sections.push(`📅 ${group.timeWindow} (${group.totalItems} items)`);
      if (group.calendar.length > 0) {
        sections.push(`  Calendar: ${group.calendar.map(c => c.title).join(', ')}`);
      }
      if (group.mail.length > 0) {
        sections.push(`  Emails: ${group.mail.map(m => m.subject).join(', ')}`);
      }
      if (group.messages.length > 0) {
        sections.push(`  Messages: ${group.messages.length} from ${[...new Set(group.messages.map(m => m.sender))].join(', ')}`);
      }
      sections.push("");
    }
    sections.push("=== Detailed Results ===\n");
  }

  if (results.mail && results.mail.success && results.mail.results.length > 0) {
    sections.push("📧 EMAILS:");
    for (const r of results.mail.results) {
      sections.push(`  [${r.rank}] Score: ${r.score}`);
      sections.push(`      From: ${r.from}`);
      sections.push(`      Subject: ${r.subject}`);
      sections.push(`      Date: ${r.date}`);
      sections.push(`      File: ${r.filePath}`);
    }
    sections.push("");
  }

  if (results.messages && results.messages.success && results.messages.results.length > 0) {
    sections.push("💬 MESSAGES:");
    for (const r of results.messages.results) {
      sections.push(`  [${r.rank}] Score: ${r.score}`);
      sections.push(`      From: ${r.sender}${r.isGroupChat ? ' (Group)' : ''}`);
      sections.push(`      Date: ${r.date}`);
      sections.push(`      Text: ${(r.text || "").substring(0, 100)}${(r.text || "").length > 100 ? "..." : ""}`);
    }
    sections.push("");
  }

  if (results.calendar && results.calendar.success && results.calendar.results.length > 0) {
    sections.push("📅 CALENDAR:");
    for (const r of results.calendar.results) {
      sections.push(`  [${r.rank}] Score: ${r.score}`);
      sections.push(`      Event: ${r.title}${r.isAllDay ? ' (All Day)' : ''}`);
      sections.push(`      Start: ${r.start}`);
      sections.push(`      Calendar: ${r.calendar}`);
      if (r.location) sections.push(`      Location: ${r.location}`);
    }
    sections.push("");
  }

  if (sections.length === 0) {
    return "No results found across Mail, Messages, or Calendar.";
  }

  return sections.join("\n");
}

// Smart search - routes to appropriate sources and optionally synthesizes results
async function smartSearch(query, options = {}) {
  const indexing = stillIndexingMessage();
  if (indexing) {
    return indexing;
  }

  const { limit = 5, synthesize = true } = options;

  const sources = detectSources(query);
  const results = {};

  // Search relevant sources in parallel
  const searches = [];

  if (sources.includes('calendar')) {
    searches.push(
      (async () => {
        const ready = await isIndexReady("calendar");
        if (ready) {
          results.calendar = await searchCalendar(query, { limit, daysBack: 30, daysAhead: 30 });
        }
      })()
    );
  }

  if (sources.includes('messages')) {
    searches.push(
      (async () => {
        const ready = await isIndexReady("messages");
        if (ready) {
          results.messages = await searchMessages(query, { limit, daysBack: 30 });
        }
      })()
    );
  }

  if (sources.includes('mail')) {
    searches.push(
      (async () => {
        const ready = await isIndexReady("emails");
        if (ready) {
          results.mail = await searchEmails(query, { limit, daysBack: 30 });
        }
      })()
    );
  }

  await Promise.all(searches);

  if (Object.keys(results).length === 0) {
    return indexUnavailableMessage();
  }

  // Synthesize results into timeline if multiple sources returned data
  let synthesizedGroups = null;
  if (synthesize) {
    const hasMultipleSources =
      (results.mail?.results?.length > 0 ? 1 : 0) +
      (results.messages?.results?.length > 0 ? 1 : 0) +
      (results.calendar?.results?.length > 0 ? 1 : 0) > 1;

    if (hasMultipleSources) {
      synthesizedGroups = synthesizeResults(
        results.mail?.results || [],
        results.messages?.results || [],
        results.calendar?.results || []
      );
    }
  }

  return formatSmartSearchResults(results, synthesizedGroups);
}

// Synthesize results from multiple sources into time-based groups
function synthesizeResults(mailResults, messageResults, calendarResults) {
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour window
  const timeline = new Map();

  // Helper to find/create time bucket
  function getBucket(timestamp) {
    if (!timestamp || isNaN(timestamp)) return null;
    const rounded = Math.floor(timestamp / WINDOW_MS) * WINDOW_MS;
    if (!timeline.has(rounded)) {
      timeline.set(rounded, { mail: [], messages: [], calendar: [] });
    }
    return timeline.get(rounded);
  }

  // Add mail results
  for (const r of mailResults) {
    const ts = toUnixMillis(r.dateTimestamp) || new Date(r.date).getTime();
    const bucket = getBucket(ts);
    if (bucket) bucket.mail.push(r);
  }

  // Add message results
  for (const r of messageResults) {
    const ts = toUnixMillis(r.dateTimestamp) || new Date(r.date).getTime();
    const bucket = getBucket(ts);
    if (bucket) bucket.messages.push(r);
  }

  // Add calendar results
  for (const r of calendarResults) {
    const ts = toUnixMillis(r.startTimestamp) || new Date(r.start).getTime();
    const bucket = getBucket(ts);
    if (bucket) bucket.calendar.push(r);
  }

  // Format grouped results
  const groups = Array.from(timeline.entries())
    .filter(([_, g]) => g.mail.length + g.messages.length + g.calendar.length > 0)
    .sort((a, b) => b[0] - a[0]) // Newest first
    .map(([ts, group]) => ({
      timeWindow: new Date(ts).toLocaleString(),
      ...group,
      totalItems: group.mail.length + group.messages.length + group.calendar.length
    }));

  return groups;
}

// ============ CONTACTS FORMATTING ============

function formatContactsSearchResults(contacts) {
  if (!contacts || contacts.length === 0) {
    return "No contacts found matching your search.";
  }

  let output = `Found ${contacts.length} contacts:\n\n`;
  for (const c of contacts) {
    output += `• ${c.displayName}`;
    if (c.organization) output += ` (${c.organization})`;
    output += "\n";
    if (c.uniqueId) output += `  Contact ID: ${c.uniqueId}\n`;
    if (c.emails.length > 0) {
      output += `  Emails: ${c.emails.map(e => e.email).join(", ")}\n`;
    }
    if (c.phones.length > 0) {
      output += `  Phones: ${c.phones.map(p => p.phone).join(", ")}\n`;
    }
    output += "\n";
  }
  return output;
}

function formatContactLookupResult(contact) {
  if (!contact) {
    return "Contact not found. Try searching with contacts_search for partial matches.";
  }

  let output = `Contact: ${contact.displayName}\n`;
  output += "─".repeat(40) + "\n";

  if (contact.uniqueId) output += `Contact ID: ${contact.uniqueId}\n`;
  if (contact.organization) output += `Organization: ${contact.organization}\n`;
  if (contact.department) output += `Department: ${contact.department}\n`;
  if (contact.jobTitle) output += `Job Title: ${contact.jobTitle}\n`;
  if (contact.nickname) output += `Nickname: ${contact.nickname}\n`;

  if (contact.emails.length > 0) {
    output += "\nEmail Addresses:\n";
    for (const e of contact.emails) {
      output += `  • ${e.email} (${e.label})\n`;
    }
  }

  if (contact.phones.length > 0) {
    output += "\nPhone Numbers:\n";
    for (const p of contact.phones) {
      output += `  • ${p.phone} (${p.label})\n`;
    }
  }

  return output;
}

// ============ PERSON SEARCH (CROSS-SOURCE) ============

async function personSearch(name, limit = 10) {
  const indexing = stillIndexingMessage();
  if (indexing) {
    return indexing;
  }

  // First, try to find the contact to get all their identifiers
  const contacts = searchContacts(name, 5);

  if (contacts.length === 0) {
    // No contact found, fall back to name-based search
    return await smartSearch(name, { limit, synthesize: true });
  }

  // Get the best matching contact
  const contact = contacts[0];
  const emails = contact.emails.map(e => e.email);
  const phones = contact.phones.map(p => p.phone);

  const results = {
    contact: {
      name: contact.displayName,
      organization: contact.organization,
      emails,
      phones
    },
    mail: null,
    messages: null,
    calendar: null
  };

  // Search all sources in parallel using the contact's identifiers
  const searches = [];

  // Mail search - search by all email addresses
  if (emails.length > 0) {
    searches.push(
      (async () => {
        const ready = await isIndexReady("emails");
        if (ready) {
          // Search for emails from any of the contact's addresses
          for (const email of emails.slice(0, 3)) {  // Limit to first 3 emails
            const emailResults = await searchEmails(contact.displayName, {
              limit,
              sender: email,
              daysBack: 365  // Last year
            });
            if (emailResults.success && emailResults.results.length > 0) {
              if (!results.mail) results.mail = emailResults;
              else results.mail.results.push(...emailResults.results);
            }
          }
        }
      })()
    );
  }

  // Messages search - search by phone numbers
  if (phones.length > 0) {
    searches.push(
      (async () => {
        const ready = await isIndexReady("messages");
        if (ready) {
          for (const phone of phones.slice(0, 3)) {  // Limit to first 3 phones
            const msgResults = await searchMessages(contact.displayName, {
              limit,
              contact: phone,
              daysBack: 365
            });
            if (msgResults.success && msgResults.results.length > 0) {
              if (!results.messages) results.messages = msgResults;
              else results.messages.results.push(...msgResults.results);
            }
          }
        }
      })()
    );
  }

  // Calendar search - search by name
  searches.push(
    (async () => {
      const ready = await isIndexReady("calendar");
      if (ready) {
        results.calendar = await searchCalendar(contact.displayName, {
          limit,
          daysBack: 90,
          daysAhead: 365
        });
      }
    })()
  );

  await Promise.all(searches);

  // Format the results
  return formatPersonSearchResults(results);
}

function formatPersonSearchResults(results) {
  const sections = [];

  // Contact info header
  sections.push(`👤 ${results.contact.name}`);
  if (results.contact.organization) {
    sections.push(`   Organization: ${results.contact.organization}`);
  }
  if (results.contact.emails.length > 0) {
    sections.push(`   Emails: ${results.contact.emails.join(", ")}`);
  }
  if (results.contact.phones.length > 0) {
    sections.push(`   Phones: ${results.contact.phones.join(", ")}`);
  }
  sections.push("");
  sections.push("=".repeat(50));
  sections.push("");

  // Email results
  if (results.mail && results.mail.results && results.mail.results.length > 0) {
    sections.push(`📧 EMAILS (${results.mail.results.length}):`);
    for (const r of results.mail.results.slice(0, 10)) {
      sections.push(`  • ${r.subject}`);
      sections.push(`    ${r.date} | ${r.from}`);
    }
    sections.push("");
  } else {
    sections.push("📧 EMAILS: None found");
    sections.push("");
  }

  // Message results
  if (results.messages && results.messages.results && results.messages.results.length > 0) {
    sections.push(`💬 MESSAGES (${results.messages.results.length}):`);
    for (const r of results.messages.results.slice(0, 10)) {
      sections.push(`  • ${(r.text || "").substring(0, 80)}${(r.text || "").length > 80 ? "..." : ""}`);
      sections.push(`    ${r.date}`);
    }
    sections.push("");
  } else {
    sections.push("💬 MESSAGES: None found");
    sections.push("");
  }

  // Calendar results
  if (results.calendar && results.calendar.results && results.calendar.results.length > 0) {
    sections.push(`📅 CALENDAR (${results.calendar.results.length}):`);
    for (const r of results.calendar.results.slice(0, 10)) {
      sections.push(`  • ${r.title}`);
      sections.push(`    ${r.start} | ${r.calendar}`);
    }
    sections.push("");
  } else {
    sections.push("📅 CALENDAR: None found");
    sections.push("");
  }

  return sections.join("\n");
}


// ============ MCP SERVER SETUP ============

const server = new Server(
  { name: "apple-tools-mcp", version: PACKAGE_VERSION },
  { capabilities: { tools: {} } }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ============ SMART SEARCH (AGENTIC) ============
    {
      name: "smart_search",
      description: "Intelligent search across Mail, Messages, and Calendar. Automatically determines which sources to search based on your query. Returns results grouped by time when multiple sources match. Use this for complex queries that might span multiple data sources.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query (e.g., 'meeting with John', 'budget discussion', 'what happened yesterday')" },
          limit: { type: "number", description: "Max results per source (default 5)" },
          synthesize: { type: "boolean", description: "Group results by time proximity (default true)" }
        },
        required: ["query"],
      },
    },

    // ============ EMAIL TOOLS ============
    {
      name: "mail_search",
      description: "Semantic search for emails using AI embeddings. Finds emails by meaning, not just keywords. Supports filtering by sender, recipient, attachments, mailbox, sent/received, and flagged.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search (e.g., 'invoices', 'meeting notes', 'from John about project')" },
          limit: { type: "number", description: "Maximum results (default 30)" },
          days_back: { type: "number", description: "Only emails from last N days (0 = all time)" },
          sender: { type: "string", description: "Filter by sender name or email address" },
          recipient: { type: "string", description: "Filter by recipient name or email address" },
          has_attachment: { type: "boolean", description: "Filter to only emails with attachments (true) or without (false)" },
          mailbox: { type: "string", description: "Filter by mailbox name (e.g., 'INBOX', 'Archive', 'Sent Messages')" },
          sent_only: { type: "boolean", description: "true = only sent emails, false = only received emails, omit for all" },
          flagged_only: { type: "boolean", description: "Only show flagged/starred emails" },
          include_junk: { type: "boolean", description: "Include emails from Junk/Trash folders (excluded by default)" },
          sort_by: { type: "string", enum: ["relevance", "date"], description: "Sort by relevance (default) or date (newest first)" }
        },
        required: ["query"],
      },
    },
    {
      name: "mail_recent",
      description: "Get most recent emails without semantic search. Use this when the user asks for 'recent emails', 'latest emails', 'what emails did I get', or 'unread emails'.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum results (default 30)" },
          days_back: { type: "number", description: "Only emails from last N days (default 7)" },
          unread_only: { type: "boolean", description: "Only show unread emails (queries Mail.app for read status)" },
          include_junk: { type: "boolean", description: "Include emails from Junk/Trash folders (excluded by default)" }
        },
      },
    },
    {
      name: "mail_date",
      description: "Get all emails from a specific date. Supports natural language like 'today', 'yesterday', 'November 13', 'last Friday'. Use this when the user asks for emails on a specific date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to retrieve emails (e.g., 'today', 'yesterday', 'Nov 13', '2025-01-15')" },
          include_junk: { type: "boolean", description: "Include emails from Junk/Trash folders (excluded by default)" }
        },
        required: ["date"],
      },
    },
    {
      name: "mail_read",
      description: "Read full email content. Use the file_path from mail_search or mail_recent results.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File path from mail_search results" },
        },
        required: ["file_path"],
      },
    },

    // ============ MESSAGES TOOLS ============
    {
      name: "messages_search",
      description: "Semantic search for iMessages/SMS using AI embeddings. Finds messages by meaning. Supports filtering by contact, group chats, specific group name, and attachments.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search (e.g., 'dinner plans', 'about the trip', 'address')" },
          limit: { type: "number", description: "Maximum results (default 30)" },
          days_back: { type: "number", description: "Only messages from last N days (0 = all time)" },
          contact: { type: "string", description: "Filter by contact name or phone number" },
          group_chat_only: { type: "boolean", description: "Only show messages from group chats" },
          group_chat_name: { type: "string", description: "Filter by specific group chat name" },
          has_attachment: { type: "boolean", description: "Filter to messages with attachments (photos, files)" },
          sort_by: { type: "string", enum: ["relevance", "date"], description: "Sort by relevance (default) or date (newest first)" }
        },
        required: ["query"],
      },
    },
    {
      name: "messages_recent",
      description: "Get most recent messages without semantic search. Use this when the user asks for 'recent messages', 'latest texts', or 'what messages did I get'.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum results (default 30)" },
          days_back: { type: "number", description: "Only messages from last N days (default 1)" }
        },
      },
    },
    {
      name: "messages_conversation",
      description: "Get full conversation history with a specific contact. Shows messages in chronological order.",
      inputSchema: {
        type: "object",
        properties: {
          contact: { type: "string", description: "Contact name or phone number" },
          limit: { type: "number", description: "Maximum messages to return (default 50)" }
        },
        required: ["contact"],
      },
    },

    // ============ CALENDAR TOOLS ============
    {
      name: "calendar_search",
      description: "Semantic search for calendar events using AI embeddings. Finds events by meaning. Supports filtering by calendar name and all-day events.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search (e.g., 'meetings', 'doctor appointments', 'lunch')" },
          limit: { type: "number", description: "Maximum results (default 30)" },
          days_back: { type: "number", description: "Include events from last N days (0 = none)" },
          days_ahead: { type: "number", description: "Include events in next N days (0 = none). Use for 'today', 'this week', etc." },
          calendar_name: { type: "string", description: "Filter to specific calendar (e.g., 'Work', 'Personal')" },
          all_day_only: { type: "boolean", description: "Only show all-day events" },
          sort_by: { type: "string", enum: ["relevance", "date"], description: "Sort by relevance (default) or date (chronological)" }
        },
        required: ["query"],
      },
    },
    {
      name: "calendar_date",
      description: "Get all events on a specific date. Supports natural language dates like 'today', 'tomorrow', 'next Tuesday', 'Jan 15'.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to check (e.g., 'today', 'tomorrow', 'next Monday', '2025-01-15')" }
        },
        required: ["date"],
      },
    },
    {
      name: "calendar_free_time",
      description: "Find free time slots on a specific date. Analyzes calendar to find available time windows.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to check (e.g., 'today', 'tomorrow', 'next Monday')" },
          start_hour: { type: "number", description: "Start of working hours (default 9 = 9 AM)" },
          end_hour: { type: "number", description: "End of working hours (default 17 = 5 PM)" },
          calendar_name: { type: "string", description: "Only consider events from this calendar" }
        },
        required: ["date"],
      },
    },

    // ============ NEW TOOLS - PHASE 1 ============

    // Mail tools
    {
      name: "mail_senders",
      description: "List most frequent email senders. Helps identify who you communicate with most.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum senders to return (default 30)" },
          days_back: { type: "number", description: "Only count emails from last N days (0 = all time)" },
          include_junk: { type: "boolean", description: "Include senders from Junk/Trash folders (excluded by default)" }
        },
      },
    },
    {
      name: "rebuild_index",
      description: "Rebuild the search index for one or more data sources. This clears the existing index and re-indexes all content from scratch. Use this if search results are stale, missing, or if the index is corrupted. Can rebuild emails, messages, calendar, or all sources at once.",
      inputSchema: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: { type: "string", enum: ["emails", "messages", "calendar"] },
            description: "Which sources to rebuild. Defaults to all sources if not specified."
          }
        },
      },
    },
    {
      name: "audit_index",
      description: "Audit search index against source data with 0% tolerance. Reports missing items, orphaned entries, and duplicates with detailed file paths and remediation suggestions. Validates 100% of source data.",
      inputSchema: {
        type: "object",
        properties: {
          sources: {
            type: "array",
            items: { type: "string", enum: ["emails", "messages", "calendar"] },
            description: "Data sources to audit (default: all)"
          },
          max_items: {
            type: "number",
            description: "Max items to list per category (default: 100, use 0 for unlimited)"
          }
        },
      },
    },

    // Messages tools
    {
      name: "messages_contacts",
      description: "List all contacts you've messaged, sorted by most recent. Shows message count and last message date.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum contacts to return (default 50)" }
        },
      },
    },

    // Calendar tools
    {
      name: "calendar_upcoming",
      description: "Get next N upcoming events across all calendars. Simpler than calendar_search for quick schedule overview.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum events to return (default 10)" }
        },
      },
    },

    // ============ NEW TOOLS - PHASE 2 ============

    {
      name: "calendar_week",
      description: "Get all events for the current week or a future week. Shows events grouped by day.",
      inputSchema: {
        type: "object",
        properties: {
          week_offset: { type: "number", description: "0 = this week, 1 = next week, 2 = week after, etc. (default 0)" }
        },
      },
    },
    // ============ NEW TOOLS - PHASE 3 ============

    {
      name: "mail_thread",
      description: "Get all emails in a conversation thread. Finds related emails by matching subject lines.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "File path to any email in the thread" },
          limit: { type: "number", description: "Maximum emails to return (default 30)" }
        },
        required: ["file_path"],
      },
    },
    {
      name: "calendar_recurring",
      description: "List recurring events (events that appear multiple times). Shows upcoming occurrences.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum recurring events to return (default 30)" }
        },
      },
    },

    // ============ CONTACTS TOOLS ============

    {
      name: "contacts_search",
      description: "Search your contacts by name, email, phone, or organization. Returns matching contacts with all their details.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (e.g., 'John', 'Acme Corp', 'john@example.com')" },
          limit: { type: "number", description: "Maximum results (default 30)" }
        },
        required: ["query"],
      },
    },
    {
      name: "contacts_lookup",
      description: "Look up a specific contact by email, phone number, or name. Returns full contact details including all emails and phone numbers.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "Email address, phone number, or name to look up" }
        },
        required: ["identifier"],
      },
    },
    {
      name: "person_search",
      description: "Search ALL communication with a specific person across Mail, Messages, and Calendar. Automatically finds their emails and phone numbers from Contacts to search all sources.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Person's name to search for (will resolve to all their email addresses and phone numbers)" },
          limit: { type: "number", description: "Maximum results per source (default 10)" }
        },
        required: ["name"],
      },
    },

    // ============ WRITE TOOLS (2.0.0) ============
    // Mail / Messages / Calendar / Contacts writes with dry_run + confirm.
    ...WRITE_TOOL_DEFINITIONS,
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    // Writes never wait on the vector index: they talk to Mail / Messages /
    // Calendar / Contacts directly and must keep working while the indexer
    // daemon holds the lock.
    if (isWriteTool(name)) {
      const writeResult = await dispatchWriteTool(name, args || {}, {
        indexerMode: INDEXER_MODE,
        socketPath: WRITE_SOCKET_PATH,
        log: (msg) => console.error(msg)
      });
      return {
        content: [{ type: "text", text: writeResult.message }],
        ...(writeResult.ok === false ? { isError: true } : {})
      };
    }

    switch (name) {
      // Smart search (agentic)
      case "smart_search":
        result = await smartSearch(args.query, {
          limit: validateLimit(args?.limit, 5, 100),
          synthesize: args?.synthesize !== false
        });
        break;

      // Email tools
      case "mail_search":
        result = await mailSearch(args.query, {
          limit: validateLimit(args?.limit, 30),
          daysBack: validateDaysBack(args?.days_back),
          sender: args?.sender || null,
          recipient: args?.recipient || null,
          hasAttachment: args?.has_attachment ?? null,
          mailbox: args?.mailbox || null,
          sentOnly: args?.sent_only ?? null,
          flaggedOnly: args?.flagged_only || false,
          includeJunk: args?.include_junk || false,
          sortBy: args?.sort_by || "relevance"
        });
        break;

      case "mail_recent":
        result = await mailRecent(
          validateLimit(args?.limit, 30),
          validateDaysBack(args?.days_back) || 7,
          args?.unread_only || false,
          args?.include_junk || false
        );
        break;

      case "mail_date":
        result = await mailDate(args.date, args?.include_junk || false);
        break;

      case "mail_read":
        result = readFullEmail(args.file_path);
        break;

      // Messages tools
      case "messages_search":
        result = await messagesSearch(args.query, {
          limit: validateLimit(args?.limit, 30),
          daysBack: validateDaysBack(args?.days_back),
          contact: args?.contact || null,
          groupChatOnly: args?.group_chat_only || false,
          groupChatName: args?.group_chat_name || null,
          hasAttachment: args?.has_attachment ?? null,
          sortBy: args?.sort_by || "relevance"
        });
        break;

      case "messages_recent":
        result = await messagesRecent(
          validateLimit(args?.limit, 30),
          validateDaysBack(args?.days_back) || 1
        );
        break;

      case "messages_conversation":
        result = await messagesConversation(args.contact, validateLimit(args?.limit, 50));
        break;

      // Calendar tools
      case "calendar_search":
        result = await calendarSearch(args.query, {
          limit: validateLimit(args?.limit, 30),
          daysBack: validateDaysBack(args?.days_back),
          daysAhead: validateDaysBack(args?.days_ahead),
          calendarName: args?.calendar_name || null,
          allDayOnly: args?.all_day_only || false,
          sortBy: args?.sort_by || "relevance"
        });
        break;

      case "calendar_date":
        result = await calendarDate(args.date);
        break;

      case "calendar_free_time":
        result = await calendarFreeTime(args.date, {
          startHour: args?.start_hour || 9,
          endHour: args?.end_hour || 17,
          calendarName: args?.calendar_name || null
        });
        break;

      // ============ NEW TOOLS - PHASE 1 ============

      // Mail tools
      case "mail_senders":
        {
          const blocked = await requireIndex("emails");
          if (blocked) {
            result = blocked;
            break;
          }
        }
        result = formatSendersResults(await getFrequentSenders(
          validateLimit(args?.limit, 30),
          validateDaysBack(args?.days_back),
          args?.include_junk || false
        ));
        break;

      case "rebuild_index":
        // Check if indexing is already in progress in this session
        if (indexingInProgress) {
          result = "Indexing is already in progress. Please wait for it to complete before starting a rebuild.";
          break;
        }

        // Acquire lock to prevent parallel rebuilds across multiple MCP instances
        if (!acquireLock()) {
          result = "Indexing is already in progress in a different session. Please wait for it to complete before starting a rebuild.";
          break;
        }

        // Start rebuild in background and return immediately
        indexingInProgress = true;
        sessionIndexComplete = false;
        const rebuildSources = args?.sources || ["emails", "messages", "calendar"];

        // Fire and forget - don't await
        rebuildIndex(rebuildSources).then((rebuildResult) => {
          applyCycleEnd(true);
          console.error("Index rebuild completed:", JSON.stringify({
            cleared: rebuildResult.cleared,
            indexed: Object.fromEntries(
              Object.entries(rebuildResult.indexed).map(([k, v]) => [k, v?.added || 0])
            ),
            errors: rebuildResult.errors.length
          }));
        }).catch(e => {
          console.error("Index rebuild error:", e.message);
          applyCycleEnd(false);
        });

        result = `🔄 Index rebuild started for: ${rebuildSources.join(", ")}.\n\nThis runs in the background and may take several minutes for large mailboxes. You can continue using other tools - searches will use the new index once complete.`;
        break;

      case "audit_index":
        {
          const auditSources = args?.sources || ["emails", "messages", "calendar"];
          const maxItems = args?.max_items !== undefined ? args.max_items : 100;

          console.error(`Starting audit for: ${auditSources.join(", ")}`);
          const auditResults = await auditAll({ sources: auditSources, maxItems });
          result = formatAuditReport(auditResults);
        }
        break;

      // Messages tools
      case "messages_contacts":
        result = formatMessageContactsResults(getMessageContacts(validateLimit(args?.limit, 50, 500)));
        break;

      // Calendar tools
      case "calendar_upcoming":
        result = formatUpcomingEventsResults(getUpcomingEvents(validateLimit(args?.limit, 30, 100)));
        break;

      // ============ NEW TOOLS - PHASE 2 ============

      case "calendar_week":
        result = formatWeekEventsResults(getWeekEvents(validateWeekOffset(args?.week_offset)));
        break;

      // ============ NEW TOOLS - PHASE 3 ============

      case "mail_thread":
        {
          const blocked = await requireIndex("emails");
          if (blocked) {
            result = blocked;
            break;
          }
        }
        result = formatEmailThreadResults(await getEmailThread(args.file_path, validateLimit(args?.limit, 30)));
        break;

      case "calendar_recurring":
        result = formatRecurringEventsResults(getRecurringEvents(validateLimit(args?.limit, 30, 100)));
        break;

      // ============ CONTACTS TOOLS ============

      case "contacts_search":
        result = formatContactsSearchResults(searchContacts(args.query, validateLimit(args?.limit, 30)));
        break;

      case "contacts_lookup":
        result = formatContactLookupResult(lookupContact(args.identifier));
        break;

      case "person_search":
        result = await personSearch(args.name, validateLimit(args?.limit, 10));
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Apple Tools MCP server running (v${PACKAGE_VERSION})`);
  // Background indexing: indexer daemon when --mode=indexer; otherwise local
  // fallback on this stdio process only if indexer.lock is free.
}

if (!PERMISSIONS_MODE && shouldConnectMcpStdio(INDEXER_MODE)) {
  main().catch(console.error);
}
