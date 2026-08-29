export async function generateDesign(requirement) {
  console.log('[DESIGN AGENT] Analyzing requirement...');
  console.log(`[DESIGN AGENT] "${requirement}"\n`);

  const architecture = generateArchitecture(requirement);
  const apiInterface = generateApiInterface(requirement);
  const dataModel = generateDataModel(requirement);

  console.log('[DESIGN AGENT] Design complete\n');

  return {
    architecture,
    apiInterface,
    dataModel,
  };
}

function generateArchitecture(requirement) {
  const lowerReq = requirement.toLowerCase();

  let architecture = `## Architecture Overview\n\n`;

  if (
    lowerReq.includes('search') ||
    lowerReq.includes('index') ||
    lowerReq.includes('vector')
  ) {
    architecture += `- **Vector Embeddings**: Use existing all-MiniLM-L6-v2 model (384-dim)
- **Search Engine**: Leverage LanceDB for similarity search
- **Caching**: Implement embedding cache (TTL=5min, max=100 entries)
- **Indexing**: Incremental indexing with background 5-minute refresh cycle
- **Multi-source**: Support Mail, Messages, Calendar sources with unified interface`;
  } else if (lowerReq.includes('tool') || lowerReq.includes('mcp')) {
    architecture += `- **MCP Server**: Extend existing index.js tool registration
- **Tool Interface**: Follow snake_case naming convention (e.g., calendar_search, mail_read)
- **Error Handling**: Validate inputs via lib/validators.js
- **Subprocess Safety**: Use lib/shell.js safe* wrappers (safeSpawn, safeSqlite3)
- **Locking**: Leverage existing lock file mechanism for concurrency control`;
  } else if (lowerReq.includes('security') || lowerReq.includes('validation')) {
    architecture += `- **Input Validation**: Use lib/validators.js for sanitization
- **Injection Prevention**: safeMatch, safeReplace, escapeSQL patterns
- **Shell Safety**: All subprocess calls via lib/shell.js with shell: false
- **Path Traversal**: Validate file paths before filesystem access
- **Test Coverage**: Add tests to tests/indexing/security/`;
  } else if (lowerReq.includes('perf') || lowerReq.includes('performance')) {
    architecture += `- **Benchmarking**: Add tests/perf/*.perf.test.js with vitest benchmarks
- **Baseline Tracking**: Use tests/perf/regression.perf.test.js for delta tracking
- **Resource Monitoring**: Measure heap usage, GC pressure, throughput
- **Profiling**: Run npm run perf to validate improvements
- **Documentation**: Update tests/perf/README.md with methodology`;
  } else if (lowerReq.includes('test')) {
    architecture += `- **Test Framework**: Vitest 2.1.0 with V8 coverage
- **Test Organization**: Unit (tests/unit/), Integration (tests/integration/), Indexing (tests/indexing/*)
- **Graceful Skipping**: Use describe.skipIf(!condition) for macOS data sources
- **Naming**: kebab-case.test.js for unit/integration, kebab-case.perf.test.js for perf
- **Setup**: Global setup via tests/helpers/setup.js validates HOME env`;
  } else {
    architecture += `- **Modularity**: Separate concerns into lib/ utilities
- **Naming**: camelCase functions with semantic prefixes (get*, format*, search*, validate*, safe*)
- **Exports**: Named exports only (no default exports)
- **Error Handling**: Fail fast with clear error messages
- **Logging**: Use console.log for debugging with [CONTEXT] prefixes`;
  }

  return architecture;
}

function generateApiInterface(requirement) {
  const lowerReq = requirement.toLowerCase();

  let apiInterface = `## API Interface\n\n`;

  if (
    lowerReq.includes('search') ||
    lowerReq.includes('query') ||
    lowerReq.includes('find')
  ) {
    apiInterface += `\`\`\`javascript
export async function search(query, options = {}) {
  // @param {string} query - Natural language search string
  // @param {object} options - Search filters (days_back, limit, sender, recipient, etc)
  // @returns {Promise<Array>} Array of matching items with score and metadata

  // Supports:
  // - Query expansion with synonym variants
  // - Pronoun resolution from session context
  // - Negation parsing (NOT, -, without)
  // - Natural language date extraction
  // - Reciprocal Rank Fusion (RRF, k=60) for multi-variant merging
}
\`\`\``;
  } else if (lowerReq.includes('index') || lowerReq.includes('cache')) {
    apiInterface += `\`\`\`javascript
export async function rebuildIndex(options = {}) {
  // @param {object} options - Configuration (days_back, rebuild_tables, etc)
  // @returns {Promise<object>} Index statistics and counts

  // Operations:
  // - Clear and recreate LanceDB tables (emails, messages, calendar)
  // - Parse .emlx files from ~/Library/Mail
  // - Query SQLite databases for Messages and Calendar
  // - Generate embeddings and store in vector DB
  // - Return indexing summary
}

export async function auditIndex() {
  // @returns {Promise<object>} Audit report (missing items, orphaned entries, duplicates)
}
\`\`\``;
  } else if (lowerReq.includes('tool') || lowerReq.includes('mcp')) {
    apiInterface += `\`\`\`javascript
export async function handleToolCall(toolName, toolInput) {
  // @param {string} toolName - Snake_case tool name (e.g., calendar_search)
  // @param {object} toolInput - Tool arguments validated against schema
  // @returns {Promise<object>} Tool result as MCP resource object

  // Validation flow:
  // 1. Check if tool exists in registry
  // 2. Validate inputs against tool schema
  // 3. Execute handler function
  // 4. Return result in MCP format
  // 5. Handle errors and return error resources
}
\`\`\``;
  } else {
    apiInterface += `\`\`\`javascript
export async function execute(input, context = {}) {
  // @param {string} input - User request or requirement
  // @param {object} context - Session context and configuration
  // @returns {Promise<object>} Result with status, data, and metadata

  // Pattern:
  // 1. Validate and parse input
  // 2. Build context from prior interactions
  // 3. Execute core logic
  // 4. Format and return results
  // 5. Cache results if applicable (TTL=5min)
}
\`\`\``;
  }

  return apiInterface;
}

function generateDataModel(requirement) {
  const lowerReq = requirement.toLowerCase();

  let dataModel = `## Data Model\n\n`;

  if (lowerReq.includes('search') || lowerReq.includes('index')) {
    dataModel += `\`\`\`javascript
// LanceDB tables
{
  emails: {
    id: UUID,
    messageId: string,      // RFC822 Message-ID
    subject: string,
    sender: string,
    recipients: string[],
    date: ISO8601,
    content: string,        // Plaintext body
    embedding: number[384], // all-MiniLM-L6-v2 embedding
    source: 'mail',
    indexed_at: ISO8601
  },

  messages: {
    id: UUID,
    guid: string,          // chat.db GUID
    contact: string,       // Phone or name
    content: string,       // Plaintext message
    date: Mac Absolute Time, // Converted to Unix
    embedding: number[384],
    source: 'messages',
    indexed_at: ISO8601
  },

  calendar: {
    id: UUID,
    title: string,
    description: string,
    startDate: ISO8601,
    endDate: ISO8601,
    location: string,
    embedding: number[384],
    source: 'calendar',
    indexed_at: ISO8601
  }
}
\`\`\``;
  } else if (lowerReq.includes('contact')) {
    dataModel += `\`\`\`javascript
{
  contact: {
    id: UUID,
    name: string,
    emails: string[],
    phones: string[],
    organization: string,
    notes: string,
    cached_at: ISO8601
  }
}
\`\`\``;
  } else {
    dataModel += `\`\`\`javascript
{
  result: {
    id: UUID,
    type: enum('EMAIL'|'MESSAGE'|'CALENDAR'|'CONTACT'),
    title: string,
    preview: string,
    score: number,        // Similarity score 0-1
    metadata: object,     // Type-specific metadata
    timestamp: ISO8601
  },

  session_context: {
    query: string,        // Last query
    person: string,       // Last person mentioned
    source: string,       // Last source filtered
    expires_at: ISO8601   // TTL 5 minutes
  }
}
\`\`\``;
  }

  return dataModel;
}
