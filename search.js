import * as chrono from "chrono-node";
import { safeOsascript } from "./lib/shell.js";
import { safeMatch, validateSearchQuery, toUnixMillis } from "./lib/validators.js";
import { embed, getOpenTable, getRecentEmails, getEmailsByDateRange, getRecentMessages, getConversation, getEventsOnDate, resolveEmail, resolvePhone, formatContact } from "./indexer.js";
import { indexUnavailableMessage } from "./lib/indexGate.js";

// ============ CACHING ============

// Embedding cache with TTL (5 minutes)
const EMBEDDING_CACHE_TTL = 5 * 60 * 1000;
const EMBEDDING_CACHE_MAX = 100;
const embeddingCache = new Map();

// Mailboxes to exclude by default (junk, trash, etc.)
const EXCLUDED_MAILBOXES = ['junk', 'trash', 'deleted messages', 'spam'];

function excludeJunkMail(results, includeJunk = false, explicitMailbox = null) {
  // Don't filter if user explicitly requested junk/trash or specified a mailbox
  if (includeJunk || explicitMailbox) return results;
  return results.filter(r =>
    !EXCLUDED_MAILBOXES.some(mb =>
      (r.mailbox || "").toLowerCase().includes(mb)
    )
  );
}

async function cachedEmbed(text) {
  const cached = embeddingCache.get(text);
  if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL) {
    return cached.vector;
  }

  const vector = await embed(text);

  // Evict oldest if at capacity
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const oldest = [...embeddingCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) embeddingCache.delete(oldest[0]);
  }

  embeddingCache.set(text, { vector, timestamp: Date.now() });
  return vector;
}

// Result cache with TTL (5 minutes)
const RESULT_CACHE_TTL = 5 * 60 * 1000;
const RESULT_CACHE_MAX = 50;
const resultCache = new Map();

function getCachedResult(cacheKey) {
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < RESULT_CACHE_TTL) {
    return cached.results;
  }
  return null;
}

function setCachedResult(cacheKey, results) {
  // Evict oldest if at capacity
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = [...resultCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) resultCache.delete(oldest[0]);
  }
  resultCache.set(cacheKey, { results, timestamp: Date.now() });
}

function buildCacheKey(type, query, options) {
  return JSON.stringify({ type, query, options });
}

// ============ AGENTIC RAG HELPERS ============

// Follow-up context: Track recent queries and extracted entities for pronoun resolution
const queryContext = {
  lastQuery: null,
  lastPerson: null,
  lastSource: null,  // 'mail', 'messages', 'calendar'
  lastTimestamp: 0
};

const CONTEXT_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Update context after a search
function updateContext(query, extractedFilters, source) {
  queryContext.lastQuery = query;
  queryContext.lastSource = source;
  queryContext.lastTimestamp = Date.now();
  if (extractedFilters.person) {
    queryContext.lastPerson = extractedFilters.person;
  }
}

// Resolve pronouns like "they", "them", "their" to previous context
function resolvePronouns(query) {
  // Check if context is still valid
  if (Date.now() - queryContext.lastTimestamp > CONTEXT_EXPIRY_MS) {
    return query;
  }

  if (!queryContext.lastPerson) {
    return query;
  }

  // Never use RegExp#test with a /g regex — lastIndex is stateful and can
  // skip the first (or only) pronoun on this or a later call. A fresh
  // regex plus replace() is lastIndex-safe; do not hoist or test() it.
  const pronounRe = new RegExp('\\b(they|them|their|he|him|his|she|her|hers)\\b', 'gi');
  return query.replace(pronounRe, queryContext.lastPerson);
}

// Extract entities (people, dates) from natural language query and convert to filters
function extractFiltersFromQuery(query) {
  const filters = {};
  const q = query.toLowerCase();

  // Extract person names: "from John", "with Sarah", "John said", "to Mike"
  // Use simpler patterns with possessive quantifiers to prevent ReDoS
  // Limit input length for safety
  const safeQuery = query.length > 500 ? query.substring(0, 500) : query;
  const personPatterns = [
    /(?:from|with|to)\s+([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)/,  // "from John Smith" - limited name length
    /([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)\s+(?:said|sent|wrote|messaged|texted|emailed)/,  // "John said"
    /(?:emails?|messages?|texts?|calls?)\s+(?:from|to|with)\s+([A-Z][a-z]{1,20})/i  // "emails from John"
  ];

  for (const pattern of personPatterns) {
    const match = safeMatch(safeQuery, pattern);
    if (match && match[1] && match[1].length > 2) {
      filters.person = match[1];
      break;
    }
  }

  // Extract date ranges using chrono-node (already imported)
  const datePatterns = {
    'yesterday': 1,
    'last week': 7,
    'this week': 7,
    'last month': 30,
    'this month': 30,
    'last few days': 3,
    'past week': 7,
    'past month': 30,
    'recent': 7,
    'recently': 7,
    'today': 1
  };

  for (const [phrase, days] of Object.entries(datePatterns)) {
    if (q.includes(phrase)) {
      filters.daysBack = days;
      break;
    }
  }

  // Extract "last N days" pattern
  const lastNDays = q.match(/last\s+(\d+)\s+days?/i);
  if (lastNDays) {
    filters.daysBack = parseInt(lastNDays[1], 10);
  }

  return filters;
}

// Apply extracted filters to search options
function applyExtractedFilters(options, extractedFilters) {
  const merged = { ...options };

  // Only apply if not already set by explicit options
  if (extractedFilters.person && !options.sender && !options.contact) {
    merged.sender = extractedFilters.person;
    merged.contact = extractedFilters.person;
  }

  if (extractedFilters.daysBack && !options.daysBack) {
    merged.daysBack = extractedFilters.daysBack;
  }

  return merged;
}

// Query expansion - generate alternative search queries for better recall
function expandQuery(query) {
  const expansions = [query]; // Always include original

  // 1. Simplified (remove time modifiers that don't affect meaning)
  const simplified = query.replace(/\b(recently|last \w+ days?|this \w+|next \w+|about|regarding)\b/gi, '').trim();
  if (simplified && simplified !== query && simplified.length > 3) {
    expansions.push(simplified);
  }

  // 2. Synonym replacement for common terms
  const synonymMap = {
    'meeting': ['call', 'sync', 'standup', 'discussion'],
    'budget': ['financial', 'costs', 'expense', 'spending'],
    'project': ['initiative', 'task', 'work', 'assignment'],
    'deadline': ['due date', 'due', 'timeline', 'delivery'],
    'review': ['feedback', 'evaluation', 'assessment', 'check'],
    'invoice': ['bill', 'payment', 'receipt', 'charge'],
    'schedule': ['calendar', 'appointment', 'booking'],
    'update': ['status', 'progress', 'news'],
    'help': ['assist', 'support', 'question'],
    'issue': ['problem', 'bug', 'error', 'concern']
  };

  for (const [word, syns] of Object.entries(synonymMap)) {
    if (query.toLowerCase().includes(word)) {
      // Add first synonym variant
      expansions.push(query.replace(new RegExp(`\\b${word}\\b`, 'gi'), syns[0]));
      break; // Only one synonym expansion
    }
  }

  return [...new Set(expansions)].slice(0, 3); // Max 3 variants, deduplicated
}

// Parse negation terms from query: "meeting NOT weekly" -> { cleanQuery: "meeting", negations: ["weekly"] }
function parseNegation(query) {
  const negations = [];
  // Match "NOT term", "-term", "without term"
  const negationPatterns = [
    /\bNOT\s+(\w+)/gi,
    /\s-(\w+)/g,
    /\bwithout\s+(\w+)/gi,
    /\bexcluding?\s+(\w+)/gi
  ];

  let cleanQuery = query;
  for (const pattern of negationPatterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      negations.push(match[1].toLowerCase());
    }
    cleanQuery = cleanQuery.replace(pattern, ' ');
  }

  return {
    cleanQuery: cleanQuery.replace(/\s+/g, ' ').trim(),
    negations: [...new Set(negations)]
  };
}

// Filter out results containing negated terms
function applyNegationFilter(results, negations, textFields = ['text', 'body', 'subject', 'title', 'notes']) {
  if (!negations || negations.length === 0) return results;

  return results.filter(r => {
    for (const field of textFields) {
      const text = (r[field] || '').toLowerCase();
      for (const neg of negations) {
        if (text.includes(neg)) {
          return false; // Exclude this result
        }
      }
    }
    return true;
  });
}

// Reciprocal Rank Fusion (RRF) for merging results from multiple query variants
// RRF(d) = Σ 1/(k + rank(d)) where k is typically 60
const RRF_K = 60;

function reciprocalRankFusion(resultSets, keyField) {
  const scores = new Map(); // key -> { doc, rrfScore }

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank];
      const key = doc[keyField];
      if (!key) continue;

      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scores.get(key);

      if (existing) {
        existing.rrfScore += rrfScore;
        // Keep the doc with better original score
        if (doc._distance && (!existing.doc._distance || doc._distance < existing.doc._distance)) {
          existing.doc = doc;
        }
      } else {
        scores.set(key, { doc, rrfScore });
      }
    }
  }

  // Sort by RRF score descending
  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ doc, rrfScore }) => ({ ...doc, _rrfScore: rrfScore }));
}

// Deduplicate results by a key field, keeping highest score (legacy, used for single-query dedup)
function deduplicateResults(results, keyField) {
  const seen = new Map();

  for (const result of results) {
    const key = result[keyField];
    if (!key) continue;

    const existing = seen.get(key);
    const currentScore = result._distance ? (1 - result._distance) : 0;
    const existingScore = existing?._distance ? (1 - existing._distance) : 0;

    if (!existing || currentScore > existingScore) {
      seen.set(key, result);
    }
  }

  return Array.from(seen.values());
}

// Self-correcting retrieval - validates results and retries with broader query if needed
const MIN_CONFIDENCE_SCORE = 0.5; // Below this score, results are considered low confidence

function assessResultQuality(results) {
  if (!results || results.length === 0) {
    return { quality: 'empty', shouldRetry: true };
  }

  // Check top result confidence
  const topScore = results[0]._distance ? (1 - results[0]._distance) : 0;

  if (topScore < MIN_CONFIDENCE_SCORE) {
    return { quality: 'low_confidence', shouldRetry: true, topScore };
  }

  if (results.length < 3 && topScore < 0.7) {
    return { quality: 'sparse', shouldRetry: true, topScore };
  }

  return { quality: 'good', shouldRetry: false, topScore };
}

// Broaden a query by removing restrictive modifiers
function broadenQuery(query) {
  // Remove time constraints
  let broader = query.replace(/\b(recently|last \w+ days?|this \w+|next \w+|yesterday|today|tomorrow)\b/gi, '');
  // Remove prepositions that narrow scope
  broader = broader.replace(/\b(about|regarding|concerning|from|to|with)\b/gi, '');
  // Clean up extra spaces
  broader = broader.replace(/\s+/g, ' ').trim();

  return broader.length > 3 ? broader : query;
}

// Hybrid search: combine vector search with keyword matching
// Returns combined score: (1 - vector_distance) * 0.7 + keyword_score * 0.3
function keywordMatch(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return 0;

  const textLower = text.toLowerCase();
  let matches = 0;
  let totalWeight = 0;

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    // Exact word match gets higher score
    const wordBoundary = new RegExp(`\\b${kwLower}\\b`, 'i');
    if (wordBoundary.test(text)) {
      matches += 1.0;
    } else if (textLower.includes(kwLower)) {
      matches += 0.5; // Partial match
    }
    totalWeight += 1;
  }

  return totalWeight > 0 ? matches / totalWeight : 0;
}

function extractKeywords(query) {
  // Remove common stop words and extract significant terms
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'any', 'both', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'it', 'its', 'my',
    'your', 'his', 'her', 'our', 'their', 'me', 'him', 'them', 'us', 'i', 'you', 'we']);

  return query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

function applyHybridScoring(results, keywords, textFields = ['text', 'body', 'subject', 'title', 'snippet']) {
  const VECTOR_WEIGHT = 0.7;
  const KEYWORD_WEIGHT = 0.3;

  return results.map(r => {
    const vectorScore = r._distance ? (1 - r._distance) : 0;

    // Calculate keyword score across relevant text fields
    let keywordScore = 0;
    let fieldCount = 0;
    for (const field of textFields) {
      if (r[field]) {
        keywordScore += keywordMatch(r[field], keywords);
        fieldCount++;
      }
    }
    keywordScore = fieldCount > 0 ? keywordScore / fieldCount : 0;

    const hybridScore = vectorScore * VECTOR_WEIGHT + keywordScore * KEYWORD_WEIGHT;

    return { ...r, _hybridScore: hybridScore, _keywordScore: keywordScore };
  }).sort((a, b) => b._hybridScore - a._hybridScore);
}

// Self-correcting search wrapper with RRF, hybrid scoring, and retry logic
async function searchWithRetry(_searchFn, tbl, query, options, keyField) {
  const { limit = 10 } = options;

  // First attempt with query expansion
  const queries = expandQuery(query);
  const fetchLimitPerQuery = Math.max(limit * 5, 50);

  // PARALLEL: Embed all query variants simultaneously using cached embeddings
  const vectors = await Promise.all(queries.map(q => cachedEmbed(q)));

  // PARALLEL: Search all variants simultaneously
  const searchPromises = vectors.map(v => tbl.search(v).limit(fetchLimitPerQuery).toArray());
  const resultSets = await Promise.all(searchPromises);

  // Use RRF to merge results from multiple query variants
  let results = reciprocalRankFusion(resultSets, keyField);
  const quality = assessResultQuality(results);

  // Only retry if NO results (not just low confidence - reduces unnecessary embedding calls)
  if (quality.quality === 'empty') {
    const broadened = broadenQuery(query);
    if (broadened !== query) {
      const broadVector = await cachedEmbed(broadened);
      const moreResults = await tbl.search(broadVector).limit(fetchLimitPerQuery).toArray();
      resultSets.push(moreResults);
      results = reciprocalRankFusion(resultSets, keyField);
    }
  }

  // Apply hybrid scoring (vector + keyword)
  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    results = applyHybridScoring(results, keywords);
  }

  return results;
}

async function getTable(type) {
  // Share indexer.js's connection so a first empty catalog is refreshed the
  // same way isIndexReady() is — not a second handle that can stay empty.
  return getOpenTable(type);
}

// Pre-warm all tables to eliminate first-query latency
export async function prewarmTables() {
  try {
    await Promise.all([
      getTable('emails'),
      getTable('messages'),
      getTable('calendar')
    ]);
    console.error('Tables pre-warmed successfully');
  } catch (e) {
    console.error('Table pre-warm warning:', e.message);
  }
}

// ============ DATE PARSING UTILITIES ============

// Format a date string to local timezone
function formatLocalDate(dateStr) {
  if (!dateStr || dateStr === "Unknown") return dateStr;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}

// Parse natural language date to start of day timestamp
export function parseNaturalDate(dateStr) {
  if (!dateStr) return null;

  // Try chrono-node first for natural language
  const parsed = chrono.parseDate(dateStr);
  if (parsed) {
    // Set to start of day
    parsed.setHours(0, 0, 0, 0);
    return parsed.getTime();
  }

  // Fallback to direct Date parsing
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  return null;
}

// Get start and end timestamps for a specific date
export function getDateRange(dateStr) {
  const start = parseNaturalDate(dateStr);
  if (!start) return null;

  // Local next midnight — not +24h, which is wrong on DST transition days
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  return { start, end: endDate.getTime() };
}

// Parse various date formats and return timestamp (for filtering results)
function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    // Try direct parsing first
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getTime();

    // Handle AppleScript format like "Friday, January 10, 2025 at 9:00:00 AM"
    const appleMatch = dateStr.match(/(\w+), (\w+ \d+, \d+) at (\d+:\d+:\d+ [AP]M)/i);
    if (appleMatch) {
      d = new Date(`${appleMatch[2]} ${appleMatch[3]}`);
      if (!isNaN(d.getTime())) return d.getTime();
    }

    return null;
  } catch {
    return null;
  }
}

// Filter results by date range
function filterByDateRange(results, daysBack, daysAhead, dateField = "date") {
  const now = Date.now();
  const cutoffPast = daysBack > 0 ? now - (daysBack * 24 * 60 * 60 * 1000) : 0;
  const cutoffFuture = daysAhead > 0 ? now + (daysAhead * 24 * 60 * 60 * 1000) : Infinity;

  if (daysBack === 0 && daysAhead === 0) return results;

  return results.filter(r => {
    const ts = toUnixMillis(r.dateTimestamp) || parseDate(r[dateField]);
    if (!ts) return daysBack === 0 && daysAhead === 0;
    return ts >= cutoffPast && ts <= cutoffFuture;
  });
}

// Sort results by date (newest first)
function sortByDate(results, descending = true) {
  return results.sort((a, b) => {
    const tsA = toUnixMillis(a.dateTimestamp) || parseDate(a.date) || parseDate(a.start) || 0;
    const tsB = toUnixMillis(b.dateTimestamp) || parseDate(b.date) || parseDate(b.start) || 0;
    return descending ? tsB - tsA : tsA - tsB;
  });
}

// ============ EMAIL SEARCH ============

export async function searchEmails(query, options = {}) {
  // Validate and sanitize query input
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  // Check result cache first
  const cacheKey = buildCacheKey('emails', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  // Resolve pronouns from previous context (e.g., "what else did they send")
  const resolvedQuery = resolvePronouns(validatedQuery);

  // Extract entities and filters from natural language
  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  // Parse negation terms (e.g., "meeting NOT weekly")
  const { cleanQuery, negations } = parseNegation(resolvedQuery);

  // Merge extracted filters with explicit options (explicit options take precedence)
  const mergedOptions = applyExtractedFilters(options, extractedFilters);

  const {
    limit = 30,
    daysBack = 0,
    sender = null,
    recipient = null,
    hasAttachment = null,
    mailbox = null,
    sentOnly = null, // true = sent, false = received, null = all
    flaggedOnly = false,
    includeJunk = false, // whether to include junk/trash/spam folders
    sortBy = "relevance" // "relevance" or "date"
  } = mergedOptions;

  const tbl = await getTable("emails");

  if (!tbl) {
    return {
      success: false,
      error: indexUnavailableMessage("emails")
    };
  }

  try {
    // Self-correcting search with query expansion, RRF, and hybrid scoring
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'filePath');

    // Apply negation filter
    results = applyNegationFilter(results, negations, ['subject', 'body', 'snippet']);

    // Apply filters
    if (daysBack > 0) {
      results = filterByDateRange(results, daysBack, 0, "date");
    }

    if (sender) {
      const senderLower = sender.toLowerCase();
      results = results.filter(r => {
        const from = (r.from || "").toLowerCase();
        const fromEmail = (r.fromEmail || "").toLowerCase();
        return from.includes(senderLower) || fromEmail.includes(senderLower);
      });
    }

    if (recipient) {
      const recipientLower = recipient.toLowerCase();
      results = results.filter(r => {
        const to = (r.to || "").toLowerCase();
        const toEmails = (r.toEmails || "").toLowerCase();
        return to.includes(recipientLower) || toEmails.includes(recipientLower);
      });
    }

    if (hasAttachment !== null) {
      results = results.filter(r => r.hasAttachment === hasAttachment);
    }

    if (mailbox) {
      const mailboxLower = mailbox.toLowerCase();
      results = results.filter(r => (r.mailbox || "").toLowerCase().includes(mailboxLower));
    }

    if (sentOnly === true) {
      results = results.filter(r => r.isSent === true);
    } else if (sentOnly === false) {
      results = results.filter(r => r.isSent === false);
    }

    if (flaggedOnly) {
      results = results.filter(r => r.isFlagged === true);
    }

    // Exclude junk/trash by default unless explicitly included or mailbox specified
    results = excludeJunkMail(results, includeJunk, mailbox);

    // Sort by date if requested
    if (sortBy === "date") {
      results = sortByDate(results, true);
    }

    // Track count before slicing for "more results" indicator
    const totalBeforeLimit = results.length;
    results = results.slice(0, limit);
    const hasMore = totalBeforeLimit > limit;

    if (results.length === 0) {
      let filterMsg = "";
      if (daysBack > 0) filterMsg += ` in the last ${daysBack} days`;
      if (sender) filterMsg += ` from ${sender}`;
      if (recipient) filterMsg += ` to ${recipient}`;
      if (hasAttachment) filterMsg += " with attachments";
      if (mailbox) filterMsg += ` in ${mailbox}`;
      if (sentOnly === true) filterMsg += " (sent)";
      if (sentOnly === false) filterMsg += " (received)";
      if (flaggedOnly) filterMsg += " (flagged)";
      return { success: true, results: [], message: `No emails found matching: ${query}${filterMsg}` };
    }

    const formattedResults = results.map((row, idx) => {
      // Resolve sender email to contact name
      const contact = resolveEmail(row.fromEmail);
      const contactName = contact ? formatContact(contact) : null;

      return {
        rank: idx + 1,
        score: row._hybridScore ? row._hybridScore.toFixed(3) : (row._distance ? (1 - row._distance).toFixed(3) : "N/A"),
        from: row.from || "Unknown",
        fromContact: contactName,  // Resolved contact name (if found)
        to: row.to || "Unknown",
        subject: row.subject || "No subject",
        date: formatLocalDate(row.date) || "Unknown",
        dateTimestamp: toUnixMillis(row.dateTimestamp) || null,
        mailbox: row.mailbox || "Unknown",
        hasAttachment: row.hasAttachment || false,
        isFlagged: row.isFlagged || false,
        preview: row.body?.substring(0, 200) || "",
        filePath: row.filePath,
        messageId: row.messageId || ""
      };
    });

    // Update context for follow-up queries
    updateContext(resolvedQuery, extractedFilters, 'mail');

    const result = {
      success: true,
      results: formattedResults,
      showing: formattedResults.length,
      hasMore
    };
    setCachedResult(cacheKey, result);
    return result;
  } catch (e) {
    return { success: false, error: `Search error: ${e.message}` };
  }
}

// Get unread email subjects and senders from Mail.app via AppleScript
// Returns { emails: [{subject, sender}, ...], error: null } or { emails: [], error: "message" }
function getUnreadEmails() {
  try {
    // Query all mailboxes (not just inbox) for unread emails
    // Returns subject and sender for precise matching
    const script = `
tell application "Mail"
    set unreadList to {}
    set maxCount to 500
    set currentCount to 0

    repeat with acc in accounts
        if currentCount >= maxCount then exit repeat
        try
            -- Get all mailboxes for this account
            set allMailboxes to every mailbox of acc
            repeat with mb in allMailboxes
                if currentCount >= maxCount then exit repeat
                try
                    -- Skip Junk/Trash/Spam folders
                    set mbName to name of mb
                    if mbName is not in {"Junk", "Trash", "Deleted Messages", "Spam", "Junk E-mail"} then
                        set unreadMsgs to (messages of mb whose read status is false)
                        repeat with msg in unreadMsgs
                            if currentCount >= maxCount then exit repeat
                            try
                                set msgSubject to subject of msg
                                set msgSender to sender of msg
                                set end of unreadList to msgSubject & "<<<>>>" & msgSender
                                set currentCount to currentCount + 1
                            end try
                        end repeat
                    end if
                end try
            end repeat
        end try
    end repeat

    set AppleScript's text item delimiters to "|||"
    return unreadList as string
end tell`;

    const result = safeOsascript(script, { timeout: 60000 });

    const emails = result.trim().split("|||")
      .filter(s => s.length > 0)
      .map(entry => {
        const [subject, sender] = entry.split("<<<>>>");
        return { subject: subject || "", sender: sender || "" };
      });
    return { emails, error: null };
  } catch (e) {
    console.error("Error getting unread emails:", e.message);
    return { emails: [], error: e.message };
  }
}

// Get recent emails without semantic search
export async function getRecentEmailResults(limit = 30, daysBack = 7, unreadOnly = false, includeJunk = false) {
  try {
    // When filtering for unread, fetch more emails since unread ones might not be the most recent
    const fetchLimit = unreadOnly ? Math.max(limit * 10, 500) : limit * 3;
    let results = await getRecentEmails(fetchLimit, daysBack);

    // Exclude junk/trash by default
    results = excludeJunkMail(results, includeJunk, null);

    // If unreadOnly, filter using AppleScript unread check
    if (unreadOnly) {
      const unreadResult = getUnreadEmails();

      // Handle AppleScript failure
      if (unreadResult.error) {
        return {
          success: false,
          error: `Could not retrieve unread status from Mail.app: ${unreadResult.error}. Make sure Mail.app is running and accessible.`
        };
      }

      if (unreadResult.emails.length > 0) {
        // Filter to only emails with matching subject AND sender
        // This prevents false positives when multiple emails have similar subjects
        results = results.filter(r => {
          const subject = (r.subject || "").trim().toLowerCase();
          // Index from field has two formats:
          // 1. "Coinbase via Cloaked (Coinbase)" - just display name
          // 2. "Jane Smith via Cloaked (Company)" <email@domain.com> - display name + email
          // Extract just the display name from both formats
          const fromRaw = (r.from || "").trim().toLowerCase();
          const fromName = fromRaw.replace(/<[^>]+>$/, "").trim().replace(/^"|"$/g, "");

          return unreadResult.emails.some(unread => {
            const unreadSubject = (unread.subject || "").trim().toLowerCase();
            // AppleScript returns: Coinbase via Cloaked (Coinbase) <email@domain.com>
            // Extract just the display name (everything before the <email>)
            const unreadSender = (unread.sender || "").trim().toLowerCase();
            const unreadName = unreadSender.replace(/<[^>]+>$/, "").trim().replace(/^"|"$/g, "");

            // Compare display names - must be strict to avoid false matches
            // Extract just the name part before "via Cloaked" if present
            const extractName = (s) => {
              const viaIndex = s.indexOf(" via cloaked");
              return viaIndex > 0 ? s.substring(0, viaIndex).trim() : s;
            };
            const fromNamePart = extractName(fromName);
            const unreadNamePart = extractName(unreadName);

            // Sender matches if:
            // 1. Full names are equal, OR
            // 2. Name parts (before "via Cloaked") are equal AND not empty
            const senderMatches =
              fromName === unreadName ||
              (fromNamePart.length > 0 && unreadNamePart.length > 0 && fromNamePart === unreadNamePart);

            if (!senderMatches) return false;

            // Now check subject match with fuzzy matching
            // Exact match
            if (unreadSubject === subject) return true;
            // Index subject is prefix of Mail.app subject (truncated in index)
            if (unreadSubject.startsWith(subject) && subject.length > 20) return true;
            // Mail.app subject is prefix of index subject
            if (subject.startsWith(unreadSubject) && unreadSubject.length > 20) return true;
            // First 40 chars match (handles calendar invites with different times)
            const prefix1 = subject.substring(0, 40);
            const prefix2 = unreadSubject.substring(0, 40);
            if (prefix1 === prefix2 && prefix1.length >= 30) return true;
            return false;
          });
        });
      } else {
        // AppleScript succeeded but no unread emails
        return { success: true, results: [], message: "You're all caught up — no unread emails found!" };
      }
    }

    // Track count before slicing
    const totalBeforeLimit = results.length;
    const hasMore = totalBeforeLimit > limit;

    const formattedResults = results.slice(0, limit).map((row, idx) => ({
      rank: idx + 1,
      from: row.from || "Unknown",
      to: row.to || "Unknown",
      subject: row.subject || "No subject",
      date: formatLocalDate(row.date) || "Unknown",
      hasAttachment: row.hasAttachment || false,
      preview: row.body?.substring(0, 200) || "",
      filePath: row.filePath,
      messageId: row.messageId || ""
    }));

    if (formattedResults.length === 0) {
      return { success: true, results: [], message: `No emails found in the last ${daysBack} days` };
    }

    return {
      success: true,
      results: formattedResults,
      showing: formattedResults.length,
      hasMore
    };
  } catch (e) {
    return { success: false, error: `Error getting recent emails: ${e.message}` };
  }
}

// Get emails from a specific date
export async function getEmailDateResults(dateStr, includeJunk = false) {
  try {
    const range = getDateRange(dateStr);
    if (!range) {
      return { success: false, error: `Could not parse date: ${dateStr}` };
    }

    let results = await getEmailsByDateRange(range.start, range.end);

    // Exclude junk/trash by default
    results = excludeJunkMail(results, includeJunk, null);

    const formattedResults = results.map((row, idx) => ({
      rank: idx + 1,
      from: row.from || "Unknown",
      to: row.to || "Unknown",
      subject: row.subject || "No subject",
      date: formatLocalDate(row.date) || "Unknown",
      hasAttachment: row.hasAttachment || false,
      preview: row.body?.substring(0, 200) || "",
      filePath: row.filePath,
      messageId: row.messageId || ""
    }));

    const dateLabel = new Date(range.start).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    if (formattedResults.length === 0) {
      return { success: true, results: [], message: `No emails on ${dateLabel}` };
    }

    return { success: true, results: formattedResults };
  } catch (e) {
    return { success: false, error: `Error getting emails by date: ${e.message}` };
  }
}

export function formatEmailResults(searchResult) {
  if (!searchResult.success) return searchResult.error || "Email search failed";
  if (searchResult.results.length === 0) return searchResult.message;

  const results = searchResult.results.map(r => {
    let result = `[${r.rank}]`;
    if (r.score) result += ` Score: ${r.score}`;
    // Show contact name if resolved, otherwise show raw from
    const fromDisplay = r.fromContact ? `${r.fromContact} <${r.from}>` : r.from;
    result += `\nFrom: ${fromDisplay}\nTo: ${r.to}\nSubject: ${r.subject}\nDate: ${r.date}`;
    if (r.hasAttachment) result += "\n📎 Has attachment";
    result += `\nPreview: ${r.preview}...`;
    result += `\nFile: ${r.filePath}`;
    return result + "\n---";
  }).join("\n");

  if (searchResult.hasMore) {
    return results + `\n\nShowing ${searchResult.showing} results. More matches exist; increase limit to see them.`;
  }
  return results;
}

// ============ MESSAGES SEARCH ============

export async function searchMessages(query, options = {}) {
  // Validate and sanitize query input
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  // Check result cache first
  const cacheKey = buildCacheKey('messages', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  // Resolve pronouns from previous context
  const resolvedQuery = resolvePronouns(validatedQuery);

  // Extract entities and filters from natural language
  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  // Parse negation terms
  const { cleanQuery, negations } = parseNegation(resolvedQuery);

  // Merge extracted filters with explicit options
  const mergedOptions = applyExtractedFilters(options, extractedFilters);

  const {
    limit = 10,
    daysBack = 0,
    contact = null,
    groupChatOnly = false,
    groupChatName = null,
    hasAttachment = null,
    sortBy = "relevance"
  } = mergedOptions;

  const tbl = await getTable("messages");

  if (!tbl) {
    return {
      success: false,
      error: indexUnavailableMessage("messages")
    };
  }

  try {
    // Self-correcting search with query expansion, RRF, and hybrid scoring
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'id');

    // Apply negation filter
    results = applyNegationFilter(results, negations, ['text']);

    if (daysBack > 0) {
      results = filterByDateRange(results, daysBack, 0, "date");
    }

    if (contact) {
      const contactLower = contact.toLowerCase();
      results = results.filter(r => {
        const sender = (r.sender || "").toLowerCase();
        const chatId = (r.chatIdentifier || "").toLowerCase();
        return sender.includes(contactLower) || chatId.includes(contactLower);
      });
    }

    if (groupChatOnly) {
      results = results.filter(r => r.isGroupChat === true);
    }

    if (groupChatName) {
      const nameLower = groupChatName.toLowerCase();
      results = results.filter(r => (r.chatName || "").toLowerCase().includes(nameLower));
    }

    if (hasAttachment !== null) {
      results = results.filter(r => r.hasAttachment === hasAttachment);
    }

    if (sortBy === "date") {
      results = sortByDate(results, true);
    }

    // Track count before slicing
    const totalBeforeLimit = results.length;
    results = results.slice(0, limit);
    const hasMore = totalBeforeLimit > limit;

    if (results.length === 0) {
      let filterMsg = "";
      if (daysBack > 0) filterMsg += ` in the last ${daysBack} days`;
      if (contact) filterMsg += ` with ${contact}`;
      if (groupChatOnly) filterMsg += " in group chats";
      if (groupChatName) filterMsg += ` in "${groupChatName}"`;
      if (hasAttachment) filterMsg += " with attachments";
      return { success: true, results: [], message: `No messages found matching: ${query}${filterMsg}` };
    }

    const formattedResults = results.map((row, idx) => {
      // Resolve sender (phone/iMessage) to contact name
      const sender = row.sender || "Unknown";
      let senderContact = null;
      if (sender !== "Me" && sender !== "Unknown") {
        const contact = resolvePhone(sender);
        if (contact) {
          senderContact = formatContact(contact);
        }
      }

      return {
        rank: idx + 1,
        score: row._hybridScore ? row._hybridScore.toFixed(3) : (row._distance ? (1 - row._distance).toFixed(3) : "N/A"),
        date: formatLocalDate(row.date) || "Unknown",
        dateTimestamp: toUnixMillis(row.dateTimestamp) || null,
        sender: sender,
        senderContact: senderContact,  // Resolved contact name (if found)
        text: row.text || "",
        chatName: row.chatName || "",
        isGroupChat: row.isGroupChat || false,
        hasAttachment: row.hasAttachment || false
      };
    });

    // Update context for follow-up queries
    updateContext(resolvedQuery, extractedFilters, 'messages');

    const result = {
      success: true,
      results: formattedResults,
      showing: formattedResults.length,
      hasMore
    };
    setCachedResult(cacheKey, result);
    return result;
  } catch (e) {
    return { success: false, error: `Search error: ${e.message}` };
  }
}

// Get recent messages without semantic search
export async function getRecentMessageResults(limit = 10, daysBack = 1) {
  try {
    const { messages, hasMore } = await getRecentMessages(limit, daysBack);

    const formattedResults = messages.map((row, idx) => {
      const sender = row.sender || "Unknown";
      let senderContact = null;
      if (sender !== "Me" && sender !== "Unknown") {
        const contact = resolvePhone(sender);
        if (contact) {
          senderContact = formatContact(contact);
        }
      }
      return {
        rank: idx + 1,
        date: formatLocalDate(row.date) || "Unknown",
        dateTimestamp: toUnixMillis(row.dateTimestamp) || null,
        sender: sender,
        senderContact: senderContact,
        text: row.text || "",
        isGroupChat: row.isGroupChat || false
      };
    });

    if (formattedResults.length === 0) {
      return { success: true, results: [], message: `No messages found in the last ${daysBack} days` };
    }

    return { success: true, results: formattedResults, showing: formattedResults.length, hasMore };
  } catch (e) {
    return { success: false, error: `Error getting recent messages: ${e.message}` };
  }
}

// Get full conversation with a contact
export async function getConversationResults(contact, limit = 50) {
  try {
    const results = await getConversation(contact, limit);

    const formattedResults = results.map((row, idx) => ({
      index: idx + 1,
      date: formatLocalDate(row.date) || "Unknown",
      sender: row.sender || "Unknown",
      text: row.text || ""
    }));

    if (formattedResults.length === 0) {
      return { success: true, results: [], message: `No conversation found with ${contact}` };
    }

    return { success: true, results: formattedResults, contact };
  } catch (e) {
    return { success: false, error: `Error getting conversation: ${e.message}` };
  }
}

export function formatMessageResults(searchResult) {
  if (!searchResult.success) return searchResult.error || "Message search failed";
  if (searchResult.results.length === 0) return searchResult.message;

  const results = searchResult.results.map(r => {
    let result = `[${r.rank || r.index}]`;
    if (r.score) result += ` Score: ${r.score}`;
    // Show contact name if resolved, otherwise show raw sender
    const senderDisplay = r.senderContact ? `${r.senderContact} (${r.sender})` : r.sender;
    result += `\nDate: ${r.date}\nFrom: ${senderDisplay}`;
    if (r.isGroupChat) result += " (Group)";
    result += `\nMessage: ${r.text}`;
    return result + "\n---";
  }).join("\n");

  if (searchResult.hasMore) {
    return results + `\n\nShowing ${searchResult.showing} results. More matches exist; increase limit to see them.`;
  }
  return results;
}

export function formatConversationResults(searchResult) {
  if (!searchResult.success) return searchResult.error;
  if (searchResult.results.length === 0) return searchResult.message;

  let output = `Conversation with ${searchResult.contact}:\n\n`;
  output += searchResult.results.map(r =>
    `[${r.date}] ${r.sender}: ${r.text}`
  ).join("\n");
  return output;
}

// ============ CALENDAR SEARCH ============

export async function searchCalendar(query, options = {}) {
  // Validate and sanitize query input
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  // Check result cache first
  const cacheKey = buildCacheKey('calendar', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  // Resolve pronouns from previous context
  const resolvedQuery = resolvePronouns(validatedQuery);

  // Extract entities and filters from natural language
  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  // Parse negation terms
  const { cleanQuery, negations } = parseNegation(resolvedQuery);

  // Merge extracted filters with explicit options
  const mergedOptions = applyExtractedFilters(options, extractedFilters);

  const {
    limit = 10,
    daysBack = 0,
    daysAhead = 0,
    calendarName = null,
    allDayOnly = false,
    sortBy = "relevance"
  } = mergedOptions;

  const tbl = await getTable("calendar");

  if (!tbl) {
    return {
      success: false,
      error: indexUnavailableMessage("calendar")
    };
  }

  try {
    // Self-correcting search with query expansion, RRF, and hybrid scoring
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'id');

    // Apply negation filter
    results = applyNegationFilter(results, negations, ['title', 'notes', 'location']);

    if (daysBack > 0 || daysAhead > 0) {
      results = filterByDateRange(results, daysBack, daysAhead, "start");
    }

    if (calendarName) {
      const calLower = calendarName.toLowerCase();
      results = results.filter(r => (r.calendar || "").toLowerCase().includes(calLower));
    }

    if (allDayOnly) {
      results = results.filter(r => r.isAllDay === true);
    }

    if (sortBy === "date") {
      results = sortByDate(results, false); // Ascending for calendar
    }

    // Track count before slicing
    const totalBeforeLimit = results.length;
    results = results.slice(0, limit);
    const hasMore = totalBeforeLimit > limit;

    if (results.length === 0) {
      let timeMsg = "";
      if (daysBack > 0) timeMsg += ` from the last ${daysBack} days`;
      if (daysAhead > 0) timeMsg += ` in the next ${daysAhead} days`;
      if (calendarName) timeMsg += ` in ${calendarName}`;
      if (allDayOnly) timeMsg += " (all-day events only)";
      return { success: true, results: [], message: `No calendar events found matching: ${query}${timeMsg}` };
    }

    const formattedResults = results.map((row, idx) => {
      // Parse attendees JSON
      let attendees = [];
      try {
        attendees = JSON.parse(row.attendees || "[]");
      } catch { attendees = []; }

      return {
        rank: idx + 1,
        score: row._hybridScore ? row._hybridScore.toFixed(3) : (row._distance ? (1 - row._distance).toFixed(3) : "N/A"),
        title: row.title || "No title",
        start: formatLocalDate(row.start) || "Unknown",
        startTimestamp: row.startTimestamp || null,
        end: formatLocalDate(row.end) || "Unknown",
        calendar: row.calendar || "Unknown",
        location: row.location || "",
        notes: row.notes || "",
        isAllDay: row.isAllDay || false,
        attendees,
        attendeeCount: row.attendeeCount || 0
      };
    });

    // Update context for follow-up queries
    updateContext(resolvedQuery, extractedFilters, 'calendar');

    const result = {
      success: true,
      results: formattedResults,
      showing: formattedResults.length,
      hasMore
    };
    setCachedResult(cacheKey, result);
    return result;
  } catch (e) {
    return { success: false, error: `Search error: ${e.message}` };
  }
}

// Local midnight of parsed date through next local midnight (handles DST; not +24h)
export function getLocalDayBounds(dateStr) {
  const start = parseNaturalDate(dateStr);
  if (start == null) return null;
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  return { start, end: endDate.getTime() };
}

// Get events on a specific date from live Calendar.sqlitedb (not the vector index)
export async function getCalendarDateResults(dateStr) {
  try {
    const range = getLocalDayBounds(dateStr);
    if (!range) {
      return { success: false, error: `Could not parse date: ${dateStr}` };
    }

    console.error(`[Calendar Date] Query for "${dateStr}"`);
    console.error(`[Calendar Date] Range: ${new Date(range.start).toString()} to ${new Date(range.end).toString()}`);

    const { events, error } = getEventsOnDate(range.start, range.end);
    if (error) {
      return { success: false, error: `Error getting calendar events: ${error}` };
    }

    const formattedResults = events.map((row, idx) => ({
      index: idx + 1,
      // iCal UID: the id the calendar write tools address events by.
      eventId: row.uid || "",
      title: row.title || "No title",
      start: formatLocalDate(row.start) || row.start || "Unknown",
      startTimestamp: row.startMac != null ? (Number(row.startMac) + 978307200) * 1000 : null,
      end: formatLocalDate(row.end) || row.end || "Unknown",
      calendar: row.calendar || "Unknown",
      location: row.location || "",
      isAllDay: !!row.isAllDay
    }));

    const dateLabel = new Date(range.start).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    if (formattedResults.length === 0) {
      return { success: true, results: [], message: `No events on ${dateLabel}`, date: dateLabel };
    }

    return { success: true, results: formattedResults, date: dateLabel };
  } catch (e) {
    return { success: false, error: `Error getting calendar events: ${e.message}` };
  }
}

// Clamp a timed event to [dayStartMs, dayEndMs) and return minutes from local midnight.
// Overnight events (23:00–01:00) contribute only the slice that falls on this day.
export function clampBusyToLocalDay(evtStartMs, evtEndMs, dayStartMs, dayEndMs) {
  const clampedStart = Math.max(evtStartMs, dayStartMs);
  const clampedEnd = Math.min(evtEndMs, dayEndMs);
  if (!(clampedEnd > clampedStart)) return null;

  const startMinutes = clampedStart <= dayStartMs
    ? 0
    : new Date(clampedStart).getHours() * 60 + new Date(clampedStart).getMinutes();
  const endMinutes = clampedEnd >= dayEndMs
    ? 24 * 60
    : new Date(clampedEnd).getHours() * 60 + new Date(clampedEnd).getMinutes();

  if (!(endMinutes > startMinutes)) return null;
  return { startMinutes, endMinutes };
}

// Calculate free time slots on a specific date
export async function calculateFreeTime(dateStr, options = {}) {
  const {
    startHour = 9,
    endHour = 17,
    calendarName = null
  } = options;

  try {
    const range = getLocalDayBounds(dateStr);
    if (!range) {
      return { success: false, error: `Could not parse date: ${dateStr}` };
    }

    const { events: liveEvents, error } = getEventsOnDate(range.start, range.end);
    if (error) {
      return { success: false, error: `Error calculating free time: ${error}` };
    }

    let events = liveEvents;

    // Filter by calendar if specified
    if (calendarName) {
      const calLower = calendarName.toLowerCase();
      events = events.filter(e => (e.calendar || "").toLowerCase().includes(calLower));
    }

    // Calculate busy periods (in minutes from start of day)
    // Skip all-day events - they're typically reminders/holidays, not actual time blocks
    const busyPeriods = [];
    for (const evt of events) {
      if (evt.isAllDay) {
        continue;
      }

      const evtStart = evt.startMac != null
        ? (Number(evt.startMac) + 978307200) * 1000
        : (evt.startTimestamp || parseDate(evt.start));
      const evtEnd = evt.endMac != null
        ? (Number(evt.endMac) + 978307200) * 1000
        : (evt.end ? parseDate(evt.end) : evtStart + (60 * 60 * 1000));

      const clamped = clampBusyToLocalDay(evtStart, evtEnd, range.start, range.end);
      if (!clamped) continue;

      const start = Math.max(clamped.startMinutes, startHour * 60);
      const end = Math.min(clamped.endMinutes, endHour * 60);
      if (end > start) {
        busyPeriods.push({ start, end });
      }
    }

    // Sort busy periods
    busyPeriods.sort((a, b) => a.start - b.start);

    // Find free slots
    const freeSlots = [];
    let currentStart = startHour * 60;

    for (const busy of busyPeriods) {
      if (busy.start > currentStart) {
        freeSlots.push({
          start: formatMinutes(currentStart),
          end: formatMinutes(busy.start),
          duration: busy.start - currentStart
        });
      }
      currentStart = Math.max(currentStart, busy.end);
    }

    // Check for free time after last event
    if (currentStart < endHour * 60) {
      freeSlots.push({
        start: formatMinutes(currentStart),
        end: formatMinutes(endHour * 60),
        duration: endHour * 60 - currentStart
      });
    }

    const dateLabel = new Date(range.start).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    return {
      success: true,
      date: dateLabel,
      workingHours: `${formatMinutes(startHour * 60)} - ${formatMinutes(endHour * 60)}`,
      totalEvents: events.length,
      freeSlots,
      totalFreeMinutes: freeSlots.reduce((sum, s) => sum + s.duration, 0)
    };
  } catch (e) {
    return { success: false, error: `Error calculating free time: ${e.message}` };
  }
}

function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h >= 12 ? "PM" : "AM";
  const hour = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${hour}:${m.toString().padStart(2, "0")} ${period}`;
}

export function formatCalendarResults(searchResult) {
  if (!searchResult.success) return searchResult.error || "Calendar search failed";
  if (searchResult.results.length === 0) return searchResult.message;

  let header = "";
  if (searchResult.date) {
    header = `Events on ${searchResult.date}:\n\n`;
  }

  const results = searchResult.results.map(r => {
    let result = `[${r.rank || r.index}]`;
    if (r.score) result += ` Score: ${r.score}`;
    result += `\nEvent: ${r.title}`;
    if (r.isAllDay) result += " (All Day)";
    result += `\nCalendar: ${r.calendar}\nStart: ${r.start}\nEnd: ${r.end}`;
    if (r.eventId) result += `\nEvent ID: ${r.eventId}`;
    if (r.location) result += `\nLocation: ${r.location}`;
    if (r.attendees && r.attendees.length > 0) {
      const attendeeList = r.attendees.map(a => `${a.name} (${a.status})`).join(", ");
      result += `\nAttendees: ${attendeeList}`;
    }
    if (r.notes) result += `\nNotes: ${r.notes}`;
    return result + "\n---";
  }).join("\n");

  if (searchResult.hasMore) {
    return header + results + `\n\nShowing ${searchResult.showing} results. More matches exist; increase limit to see them.`;
  }
  return header + results;
}

export function formatFreeTimeResults(result) {
  if (!result.success) return result.error;

  let output = `Free Time on ${result.date}\n`;
  output += `Working hours: ${result.workingHours}\n`;
  output += `Events scheduled: ${result.totalEvents}\n\n`;

  if (result.freeSlots.length === 0) {
    output += "No free time available during working hours.";
  } else {
    output += "Available slots:\n";
    for (const slot of result.freeSlots) {
      const hours = Math.floor(slot.duration / 60);
      const mins = slot.duration % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      output += `  • ${slot.start} - ${slot.end} (${durationStr})\n`;
    }
    const totalHours = Math.floor(result.totalFreeMinutes / 60);
    const totalMins = result.totalFreeMinutes % 60;
    output += `\nTotal free time: ${totalHours}h ${totalMins}m`;
  }

  return output;
}

// ============ NEW TOOLS FORMATTING - PHASE 1 ============

// Format mail_senders results
export function formatSendersResults(senders) {
  if (!senders || senders.length === 0) {
    return "No senders found in the index.";
  }

  let output = `Top ${senders.length} email senders:\n\n`;
  for (let i = 0; i < senders.length; i++) {
    const s = senders[i];
    output += `  ${i + 1}. ${s.email} (${s.messageCount} emails)\n`;
  }
  return output;
}

// Format messages_contacts results
export function formatMessageContactsResults(contacts) {
  if (contacts?.error) {
    return `Error getting message contacts: ${contacts.error}`;
  }
  if (!contacts || contacts.length === 0) {
    return "No message contacts found.";
  }

  let output = `Found ${contacts.length} contacts:\n\n`;
  for (const c of contacts) {
    output += `  • ${c.contact}\n`;
    output += `    Messages: ${c.messageCount} | Last: ${c.lastMessageDate || "Unknown"}\n`;
  }
  return output;
}

// Format calendar_upcoming results
export function formatUpcomingEventsResults(result) {
  if (result?.error) {
    return `Error getting upcoming events: ${result.error}`;
  }
  const events = result.events || result; // Handle both new {events, showing, hasMore} and old array format
  if (!events || events.length === 0) {
    return "No upcoming events found.";
  }

  let output = "";
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    output += `${i + 1}. ${e.title || "No title"}${e.isAllDay ? " (All Day)" : ""}\n`;
    output += `   ${e.start}${e.isAllDay ? "" : ` - ${e.end}`}\n`;
    output += `   Calendar: ${e.calendar || "Unknown"}`;
    if (e.location) output += ` | Location: ${e.location}`;
    output += "\n\n";
  }

  return output;
}

// ============ NEW TOOLS FORMATTING - PHASE 2 ============

// Format mail_unread_count results
export function formatUnreadCountResults(result) {
  if (result.error) {
    return `Error getting unread count: ${result.error}`;
  }
  return `Unread emails in ${result.mailbox}: ${result.unreadCount}`;
}

// Format calendar_week results
export function formatWeekEventsResults(result) {
  if (result.error) {
    return `Error getting week events: ${result.error}`;
  }

  const events = result.events || [];
  if (events.length === 0) {
    return `No events scheduled for ${result.weekLabel} (${result.dateRange})`;
  }

  let output = `${result.weekLabel} (${result.dateRange})\n`;
  output += `${events.length} events scheduled:\n\n`;

  // Group by day
  const byDay = {};
  for (const e of events) {
    const day = e.start.split(" ")[0]; // Extract date part
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(e);
  }

  for (const [day, dayEvents] of Object.entries(byDay)) {
    output += `${day}:\n`;
    for (const e of dayEvents) {
      const time = e.isAllDay ? "All Day" : e.start.split(" ")[1];
      output += `  • ${time} - ${e.title || "No title"}`;
      if (e.calendar) output += ` [${e.calendar}]`;
      output += "\n";
    }
    output += "\n";
  }

  return output;
}

// ============ NEW TOOLS FORMATTING - PHASE 3 ============

// Format mail_thread results
export function formatEmailThreadResults(result) {
  if (result.error) {
    if (result.error === indexUnavailableMessage("emails")) {
      return result.error;
    }
    return `Error: ${result.error}`;
  }

  const emails = result.emails || [];
  if (emails.length === 0) {
    return "No related emails found in thread.";
  }

  let output = `Email Thread: "${result.baseSubject}"\n`;
  output += `Found ${result.threadCount} related emails:\n\n`;

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    output += `${i + 1}. ${e.from || "Unknown"}\n`;
    output += `   Subject: ${e.subject || "No subject"}\n`;
    output += `   Date: ${e.date || "Unknown"}\n`;
    output += `   File: ${e.filePath}\n\n`;
  }
  return output;
}

// Format calendar_recurring results
export function formatRecurringEventsResults(result) {
  if (result?.error) {
    return `Error getting recurring events: ${result.error}`;
  }
  const events = result.events || result; // Handle both new {events, showing, hasMore} and old array format
  if (!events || events.length === 0) {
    return "No recurring events found.";
  }

  let output = "";
  for (const e of events) {
    output += `  • ${e.title || "No title"}${e.isAllDay ? " (All Day)" : ""}\n`;
    output += `    Next: ${e.start} | Calendar: ${e.calendar || "Unknown"}\n`;
    output += `    Occurrences: ${e.occurrenceCount}\n\n`;
  }

  return output;
}

// Export internal functions for testing
export { expandQuery, parseNegation, extractKeywords, resolvePronouns, updateContext };
