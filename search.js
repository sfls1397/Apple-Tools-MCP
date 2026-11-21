import * as chrono from "chrono-node";
import { safeOsascript } from "./lib/shell.js";
import { safeMatch, validateSearchQuery, toUnixMillis } from "./lib/validators.js";
import { embed, getOpenTable, getRecentEmails, getEmailsByDateRange, getRecentMessages, getConversation, getEventsOnDate, resolveEmail, resolvePhone, resolveByExactName, normalizePhone, formatContact } from "./indexer.js";
import { createMessageContactMatcher, describeMessagePeer } from "./lib/messageContact.js";
import { indexUnavailableMessage } from "./lib/indexGate.js";
import { hideMeetingSecrets } from "./lib/urlQuery.js";


const EMBEDDING_CACHE_TTL = 5 * 60 * 1000;
const EMBEDDING_CACHE_MAX = 100;
const embeddingCache = new Map();

const EXCLUDED_MAILBOXES = ['junk', 'trash', 'deleted messages', 'spam'];

function excludeJunkMail(results, includeJunk = false, explicitMailbox = null) {
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

  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const oldest = [...embeddingCache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
    if (oldest) embeddingCache.delete(oldest[0]);
  }

  embeddingCache.set(text, { vector, timestamp: Date.now() });
  return vector;
}

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


const queryContext = {
  lastQuery: null,
  lastPerson: null,
  lastSource: null,
  lastTimestamp: 0
};

const CONTEXT_EXPIRY_MS = 5 * 60 * 1000;

function updateContext(query, extractedFilters, source) {
  queryContext.lastQuery = query;
  queryContext.lastSource = source;
  queryContext.lastTimestamp = Date.now();
  if (extractedFilters.person) {
    queryContext.lastPerson = extractedFilters.person;
  }
}

function resolvePronouns(query) {
  if (Date.now() - queryContext.lastTimestamp > CONTEXT_EXPIRY_MS) {
    return query;
  }

  if (!queryContext.lastPerson) {
    return query;
  }

  const pronounRe = new RegExp('\\b(they|them|their|he|him|his|she|her|hers)\\b', 'gi');
  return query.replace(pronounRe, queryContext.lastPerson);
}

function extractFiltersFromQuery(query) {
  const filters = {};
  const q = query.toLowerCase();

  const safeQuery = query.length > 500 ? query.substring(0, 500) : query;
  const personPatterns = [
    /(?:from|with|to)\s+([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)/,
    /([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)\s+(?:said|sent|wrote|messaged|texted|emailed)/,
    /(?:emails?|messages?|texts?|calls?)\s+(?:from|to|with)\s+([A-Z][a-z]{1,20})/i
  ];

  for (const pattern of personPatterns) {
    const match = safeMatch(safeQuery, pattern);
    if (match && match[1] && match[1].length > 2) {
      filters.person = match[1];
      break;
    }
  }

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

  const lastNDays = q.match(/last\s+(\d+)\s+days?/i);
  if (lastNDays) {
    filters.daysBack = parseInt(lastNDays[1], 10);
  }

  return filters;
}

function applyExtractedFilters(options, extractedFilters) {
  const merged = { ...options };

  if (extractedFilters.person && !options.sender && !options.contact) {
    merged.sender = extractedFilters.person;
    merged.contact = extractedFilters.person;
  }

  if (extractedFilters.daysBack && !options.daysBack) {
    merged.daysBack = extractedFilters.daysBack;
  }

  return merged;
}

function expandQuery(query) {
  const expansions = [query];

  const simplified = query.replace(/\b(recently|last \w+ days?|this \w+|next \w+|about|regarding)\b/gi, '').trim();
  if (simplified && simplified !== query && simplified.length > 3) {
    expansions.push(simplified);
  }

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
      expansions.push(query.replace(new RegExp(`\\b${word}\\b`, 'gi'), syns[0]));
      break;
    }
  }

  return [...new Set(expansions)].slice(0, 3);
}

function parseNegation(query) {
  const negations = [];
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

function applyNegationFilter(results, negations, textFields = ['text', 'body', 'subject', 'title', 'notes']) {
  if (!negations || negations.length === 0) return results;

  return results.filter(r => {
    for (const field of textFields) {
      const text = (r[field] || '').toLowerCase();
      for (const neg of negations) {
        if (text.includes(neg)) {
          return false;
        }
      }
    }
    return true;
  });
}

const RRF_K = 60;

function reciprocalRankFusion(resultSets, keyField) {
  const scores = new Map();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const doc = results[rank];
      const key = doc[keyField];
      if (!key) continue;

      const rrfScore = 1 / (RRF_K + rank + 1);
      const existing = scores.get(key);

      if (existing) {
        existing.rrfScore += rrfScore;
        if (doc._distance && (!existing.doc._distance || doc._distance < existing.doc._distance)) {
          existing.doc = doc;
        }
      } else {
        scores.set(key, { doc, rrfScore });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ doc, rrfScore }) => ({ ...doc, _rrfScore: rrfScore }));
}

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

const MIN_CONFIDENCE_SCORE = 0.5;

function assessResultQuality(results) {
  if (!results || results.length === 0) {
    return { quality: 'empty', shouldRetry: true };
  }

  const topScore = results[0]._distance ? (1 - results[0]._distance) : 0;

  if (topScore < MIN_CONFIDENCE_SCORE) {
    return { quality: 'low_confidence', shouldRetry: true, topScore };
  }

  if (results.length < 3 && topScore < 0.7) {
    return { quality: 'sparse', shouldRetry: true, topScore };
  }

  return { quality: 'good', shouldRetry: false, topScore };
}

function broadenQuery(query) {
  let broader = query.replace(/\b(recently|last \w+ days?|this \w+|next \w+|yesterday|today|tomorrow)\b/gi, '');
  broader = broader.replace(/\b(about|regarding|concerning|from|to|with)\b/gi, '');
  broader = broader.replace(/\s+/g, ' ').trim();

  return broader.length > 3 ? broader : query;
}

function keywordMatch(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return 0;

  const textLower = text.toLowerCase();
  let matches = 0;
  let totalWeight = 0;

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    const wordBoundary = new RegExp(`\\b${kwLower}\\b`, 'i');
    if (wordBoundary.test(text)) {
      matches += 1.0;
    } else if (textLower.includes(kwLower)) {
      matches += 0.5;
    }
    totalWeight += 1;
  }

  return totalWeight > 0 ? matches / totalWeight : 0;
}

function extractKeywords(query) {
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

async function searchWithRetry(_searchFn, tbl, query, options, keyField) {
  const { limit = 10 } = options;

  const queries = expandQuery(query);
  const fetchLimitPerQuery = Math.max(limit * 5, 50);

  const vectors = await Promise.all(queries.map(q => cachedEmbed(q)));

  const searchPromises = vectors.map(v => tbl.search(v).limit(fetchLimitPerQuery).toArray());
  const resultSets = await Promise.all(searchPromises);

  let results = reciprocalRankFusion(resultSets, keyField);
  const quality = assessResultQuality(results);

  if (quality.quality === 'empty') {
    const broadened = broadenQuery(query);
    if (broadened !== query) {
      const broadVector = await cachedEmbed(broadened);
      const moreResults = await tbl.search(broadVector).limit(fetchLimitPerQuery).toArray();
      resultSets.push(moreResults);
      results = reciprocalRankFusion(resultSets, keyField);
    }
  }

  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    results = applyHybridScoring(results, keywords);
  }

  return results;
}

async function getTable(type) {
  return getOpenTable(type);
}

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

export function parseNaturalDate(dateStr) {
  if (!dateStr) return null;

  const parsed = chrono.parseDate(dateStr);
  if (parsed) {
    parsed.setHours(0, 0, 0, 0);
    return parsed.getTime();
  }

  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  return null;
}

export function getDateRange(dateStr) {
  const start = parseNaturalDate(dateStr);
  if (!start) return null;

  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  return { start, end: endDate.getTime() };
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getTime();

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

function sortByDate(results, descending = true) {
  return results.sort((a, b) => {
    const tsA = toUnixMillis(a.dateTimestamp) || parseDate(a.date) || parseDate(a.start) || 0;
    const tsB = toUnixMillis(b.dateTimestamp) || parseDate(b.date) || parseDate(b.start) || 0;
    return descending ? tsB - tsA : tsA - tsB;
  });
}


export async function searchEmails(query, options = {}) {
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  const cacheKey = buildCacheKey('emails', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  const resolvedQuery = resolvePronouns(validatedQuery);

  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  const { cleanQuery, negations } = parseNegation(resolvedQuery);

  const mergedOptions = applyExtractedFilters(options, extractedFilters);

  const {
    limit = 30,
    daysBack = 0,
    sender = null,
    recipient = null,
    hasAttachment = null,
    mailbox = null,
    sentOnly = null,
    flaggedOnly = false,
    includeJunk = false,
    sortBy = "relevance"
  } = mergedOptions;

  const tbl = await getTable("emails");

  if (!tbl) {
    return {
      success: false,
      error: indexUnavailableMessage("emails")
    };
  }

  try {
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'filePath');

    results = applyNegationFilter(results, negations, ['subject', 'body', 'snippet']);

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

    results = excludeJunkMail(results, includeJunk, mailbox);

    if (sortBy === "date") {
      results = sortByDate(results, true);
    }

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
      const contact = resolveEmail(row.fromEmail);
      const contactName = contact ? formatContact(contact) : null;

      return {
        rank: idx + 1,
        score: row._hybridScore ? row._hybridScore.toFixed(3) : (row._distance ? (1 - row._distance).toFixed(3) : "N/A"),
        from: row.from || "Unknown",
        fromContact: contactName,
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

function getUnreadEmails() {
  try {
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

export async function getRecentEmailResults(limit = 30, daysBack = 7, unreadOnly = false, includeJunk = false) {
  try {
    const fetchLimit = unreadOnly ? Math.max(limit * 10, 500) : limit * 3;
    let results = await getRecentEmails(fetchLimit, daysBack);

    results = excludeJunkMail(results, includeJunk, null);

    if (unreadOnly) {
      const unreadResult = getUnreadEmails();

      if (unreadResult.error) {
        return {
          success: false,
          error: `Could not retrieve unread status from Mail.app: ${unreadResult.error}. Make sure Mail.app is running and accessible.`
        };
      }

      if (unreadResult.emails.length > 0) {
        results = results.filter(r => {
          const subject = (r.subject || "").trim().toLowerCase();
          const fromRaw = (r.from || "").trim().toLowerCase();
          const fromName = fromRaw.replace(/<[^>]+>$/, "").trim().replace(/^"|"$/g, "");

          return unreadResult.emails.some(unread => {
            const unreadSubject = (unread.subject || "").trim().toLowerCase();
            const unreadSender = (unread.sender || "").trim().toLowerCase();
            const unreadName = unreadSender.replace(/<[^>]+>$/, "").trim().replace(/^"|"$/g, "");

            const extractName = (s) => {
              const viaIndex = s.indexOf(" via cloaked");
              return viaIndex > 0 ? s.substring(0, viaIndex).trim() : s;
            };
            const fromNamePart = extractName(fromName);
            const unreadNamePart = extractName(unreadName);

            const senderMatches =
              fromName === unreadName ||
              (fromNamePart.length > 0 && unreadNamePart.length > 0 && fromNamePart === unreadNamePart);

            if (!senderMatches) return false;

            if (unreadSubject === subject) return true;
            if (unreadSubject.startsWith(subject) && subject.length > 20) return true;
            if (subject.startsWith(unreadSubject) && unreadSubject.length > 20) return true;
            const prefix1 = subject.substring(0, 40);
            const prefix2 = unreadSubject.substring(0, 40);
            if (prefix1 === prefix2 && prefix1.length >= 30) return true;
            return false;
          });
        });
      } else {
        return { success: true, results: [], message: "You're all caught up — no unread emails found!" };
      }
    }

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

export async function getEmailDateResults(dateStr, includeJunk = false) {
  try {
    const range = getDateRange(dateStr);
    if (!range) {
      return { success: false, error: `Could not parse date: ${dateStr}` };
    }

    let results = await getEmailsByDateRange(range.start, range.end);

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


export async function searchMessages(query, options = {}) {
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  const cacheKey = buildCacheKey('messages', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  const resolvedQuery = resolvePronouns(validatedQuery);

  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  const { cleanQuery, negations } = parseNegation(resolvedQuery);

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
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'id');

    results = applyNegationFilter(results, negations, ['text']);

    if (daysBack > 0) {
      results = filterByDateRange(results, daysBack, 0, "date");
    }

    if (contact) {
      const matcher = createMessageContactMatcher(contact, { resolveExactName: resolveByExactName, normalizePhone });
      if (matcher) results = results.filter(r => matcher.matches(r));
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

    const totalBeforeLimit = results.length;
    results = results.slice(0, limit);
    const hasMore = totalBeforeLimit > limit;

    if (results.length === 0) {
      let filterMsg = "";
      if (daysBack > 0) filterMsg += ` in the last ${daysBack} days`;
      if (contact) {
        filterMsg += ` with ${contact}`;
        const matcher = createMessageContactMatcher(contact, { resolveExactName: resolveByExactName, normalizePhone });
        if (matcher?.isName && matcher.resolvedCount === 0) filterMsg += ` (no contact named "${contact}")`;
      }
      if (groupChatOnly) filterMsg += " in group chats";
      if (groupChatName) filterMsg += ` in "${groupChatName}"`;
      if (hasAttachment) filterMsg += " with attachments";
      return { success: true, results: [], message: `No messages found matching: ${query}${filterMsg}` };
    }

    const formattedResults = results.map((row, idx) => {
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
        senderContact: senderContact,
        to: sender === "Me" ? messagePeer(row) : null,
        text: row.text || "",
        chatName: row.chatName || "",
        isGroupChat: row.isGroupChat || false,
        hasAttachment: row.hasAttachment || false
      };
    });

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

function messagePeer(row) {
  return describeMessagePeer(row, { resolvePhone, resolveEmail, formatContact });
}

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
        to: sender === "Me" ? messagePeer(row) : null,
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
      const matcher = createMessageContactMatcher(contact, { resolveExactName: resolveByExactName, normalizePhone });
      const hint = matcher?.isName && matcher.resolvedCount === 0
        ? ` (no contact named "${contact}"; try a phone number or email)`
        : "";
      return { success: true, results: [], message: `No conversation found with ${contact}${hint}` };
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
    const senderDisplay = r.senderContact ? `${r.senderContact} (${r.sender})` : r.sender;
    result += `\nDate: ${r.date}\nFrom: ${senderDisplay}`;
    if (r.isGroupChat) result += " (Group)";
    if (r.to) result += `\nTo: ${r.to}`;
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


export async function searchCalendar(query, options = {}) {
  let validatedQuery;
  try {
    validatedQuery = validateSearchQuery(query);
  } catch (e) {
    return { success: false, results: [], error: e.message };
  }

  const cacheKey = buildCacheKey('calendar', validatedQuery, options);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  const resolvedQuery = resolvePronouns(validatedQuery);

  const extractedFilters = extractFiltersFromQuery(resolvedQuery);

  const { cleanQuery, negations } = parseNegation(resolvedQuery);

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
    let results = await searchWithRetry(null, tbl, cleanQuery, { limit }, 'id');

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
      results = sortByDate(results, false);
    }

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

export function getLocalDayBounds(dateStr) {
  const start = parseNaturalDate(dateStr);
  if (start == null) return null;
  const endDate = new Date(start);
  endDate.setDate(endDate.getDate() + 1);
  return { start, end: endDate.getTime() };
}

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

    if (calendarName) {
      const calLower = calendarName.toLowerCase();
      events = events.filter(e => (e.calendar || "").toLowerCase().includes(calLower));
    }

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

    busyPeriods.sort((a, b) => a.start - b.start);

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
    result += `\nEvent: ${hideMeetingSecrets(r.title)}`;
    if (r.isAllDay) result += " (All Day)";
    result += `\nCalendar: ${r.calendar}\nStart: ${r.start}\nEnd: ${r.end}`;
    if (r.eventId) result += `\nEvent ID: ${r.eventId}`;
    if (r.location) result += `\nLocation: ${hideMeetingSecrets(r.location)}`;
    if (r.attendees && r.attendees.length > 0) {
      const attendeeList = r.attendees.map(a => `${a.name} (${a.status})`).join(", ");
      result += `\nAttendees: ${attendeeList}`;
    }
    if (r.notes) result += `\nNotes: ${hideMeetingSecrets(r.notes)}`;
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

export function requireCalendarRead(result) {
  if (result?.success === false) {
    throw new Error(result.error || "The calendar could not be read");
  }
  if (result?.error) {
    throw new Error(`Error getting upcoming events: ${result.error}`);
  }
  return result;
}

export function formatUpcomingEventsResults(result) {
  if (result?.error) {
    return `Error getting upcoming events: ${result.error}`;
  }
  const events = result.events || result;
  if (!events || events.length === 0) {
    return "No upcoming events found.";
  }

  let output = "";
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    output += `${i + 1}. ${hideMeetingSecrets(e.title) || "No title"}${e.isAllDay ? " (All Day)" : ""}\n`;
    output += `   ${e.start}${e.isAllDay ? "" : ` - ${e.end}`}\n`;
    output += `   Calendar: ${e.calendar || "Unknown"}`;
    if (e.location) output += ` | Location: ${hideMeetingSecrets(e.location)}`;
    output += "\n\n";
  }

  return output;
}


export function formatUnreadCountResults(result) {
  if (result.error) {
    return `Error getting unread count: ${result.error}`;
  }
  return `Unread emails in ${result.mailbox}: ${result.unreadCount}`;
}

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

  const byDay = {};
  for (const e of events) {
    const day = e.start.split(" ")[0];
    if (!byDay[day]) byDay[day] = [];
    byDay[day].push(e);
  }

  for (const [day, dayEvents] of Object.entries(byDay)) {
    output += `${day}:\n`;
    for (const e of dayEvents) {
      const time = e.isAllDay ? "All Day" : e.start.split(" ")[1];
      output += `  • ${time} - ${hideMeetingSecrets(e.title) || "No title"}`;
      if (e.calendar) output += ` [${e.calendar}]`;
      output += "\n";
    }
    output += "\n";
  }

  return output;
}


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

export function formatRecurringEventsResults(result) {
  if (result?.error) {
    return `Error getting recurring events: ${result.error}`;
  }
  const events = result.events || result;
  if (!events || events.length === 0) {
    return "No recurring events found.";
  }

  let output = "";
  for (const e of events) {
    output += `  • ${hideMeetingSecrets(e.title) || "No title"}${e.isAllDay ? " (All Day)" : ""}\n`;
    output += `    Next: ${e.start} | Calendar: ${e.calendar || "Unknown"}\n`;
    output += `    Occurrences: ${e.occurrenceCount}\n\n`;
  }

  return output;
}

export { expandQuery, parseNegation, extractKeywords, resolvePronouns, updateContext };
