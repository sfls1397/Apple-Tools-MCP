# Performance Test Suite

Comprehensive performance testing for apple-tools-mcp. This suite measures performance across all aspects of the MCP server including indexing, searching, tool execution, and memory management.

## Quick Start

```bash
# Run all performance tests
npm run perf

# Run quick smoke tests (tools + search)
npm run perf:quick

# Run full suite with extended timeout
npm run perf:full

# Watch mode for development
npm run perf:watch
```

## Test Categories

### Core Operations

| Command | Description |
|---------|-------------|
| `npm run perf` | Run all performance tests |
| `npm run perf:quick` | Quick smoke tests (tools + search) |
| `npm run perf:full` | Full suite with 2-minute timeout |
| `npm run perf:negative` | Error handling and failure path tests |
| `npm run perf:edge-cases` | Boundary condition and edge case tests |
| `npm run perf:regression` | Baseline comparisons and regression detection |
| `npm run perf:lancedb` | Vector database operations |
| `npm run perf:background` | Background indexing system impact |
| `npm run perf:dates` | Date parsing performance |

### Indexing Performance

```bash
npm run perf:indexing
```

Tests:
- Email indexing throughput (100, 1000, 10000 emails)
- Message indexing efficiency
- Calendar event indexing
- Incremental indexing performance
- Full reindex timing
- Batch processing optimization
- Scaling behavior

### Search Performance

```bash
npm run perf:search
```

Tests:
- Vector search latency (10k records)
- Concurrent search handling
- Query expansion speed
- Hybrid scoring efficiency
- Reciprocal Rank Fusion (RRF) merging
- End-to-end search pipeline
- Cross-source smart search
- Latency distribution analysis

### Tool Performance

```bash
npm run perf:tools
```

Tests:
- Individual tool latency (all 21 tools)
- Tool dispatch overhead
- Concurrent tool execution
- Response formatting speed
- Email tools (mail_search, mail_recent, mail_read, etc.)
- Message tools (messages_search, messages_conversation, etc.)
- Calendar tools (calendar_search, calendar_free_time, etc.)
- Contact tools (contacts_search, person_search, etc.)

### MCP Server Performance

```bash
npm run perf:server
```

Tests:
- Server initialization time
- Tool registration speed
- Request/response cycle
- JSON parsing/serialization
- Protocol overhead
- Concurrent request handling
- Error handling performance
- Memory efficiency under load

### Embedding Performance

```bash
npm run perf:embedding
```

Tests:
- Model loading time
- Single text embedding latency
- Batch embedding throughput
- Vector operations (cosine similarity, top-k)
- Cache hit/miss performance
- Memory efficiency
- Latency distribution

### Data Source Performance

```bash
npm run perf:datasources
```

Tests each data source in isolation:

```bash
# Test specific data sources
npm run perf:mail      # Email/Mail.app
npm run perf:messages  # iMessage
npm run perf:calendar  # Calendar.app
npm run perf:contacts  # Contacts.app
```

**Email tests:**
- .emlx file parsing
- Attachment detection
- Header extraction
- Sender aggregation
- mdfind result processing

**Message tests:**
- SQLite query performance
- Binary format (attributedBody) parsing
- Group chat detection
- Contact aggregation

**Calendar tests:**
- Event querying
- Date range filtering
- Free time calculation
- Recurring event expansion

**Contact tests:**
- Contact loading
- Lookup map construction
- Email/phone resolution
- Full-text search

### Memory Performance

```bash
npm run perf:memory
```

Tests:
- Heap usage during indexing
- Memory bounds enforcement
- Leak detection (repeated operations)
- Cache memory limits
- Resource cleanup
- Concurrent memory usage
- Array buffer management
- String processing memory

### Stress Tests

```bash
npm run perf:stress
```

Tests:
- High volume operations (10k+ items)
- Sustained load (100+ consecutive operations)
- 20 concurrent operations
- Burst handling (50 requests)
- Maximum result sets
- Long queries
- Large email bodies
- Memory under stress
- Recovery from slowdowns
- Maximum throughput measurement

### Negative Testing

```bash
npm run perf:negative
```

Tests error handling and failure path performance:

- **Error Handling Performance** - Thrown errors, rejected promises, timeout recovery
- **Invalid Input Handling** - Null/undefined, wrong types, malformed data, SQL injection patterns
- **Missing/Corrupted Data** - Missing files, corrupted .emlx content, damaged SQLite responses
- **Resource Exhaustion** - Memory pressure, connection pool depletion, file descriptor limits
- **Timeout Behavior** - Slow operations, timeout enforcement, partial results
- **Graceful Degradation** - Fallback mechanisms, partial failures, cascade prevention
- **Error Logging** - Log capture performance, log rotation under load
- **Cleanup After Errors** - Resource cleanup, no orphaned connections, state reset

### Edge Case Testing

```bash
npm run perf:edge-cases
```

Tests boundary conditions and unusual scenarios:

- **Data Boundaries** - Empty data, single item, maximum size, exactly-at-limit
- **Content Edge Cases** - Unicode (emoji, RTL, zero-width), binary content, control characters
- **Date/Time Edge Cases** - DST transitions, timezone boundaries, leap years, epoch edge values
- **Search Edge Cases** - Single char queries, special regex chars, stop words, exact duplicates
- **Threading Edge Cases** - Rapid sequential, interleaved queries, shared state
- **Contact Edge Cases** - Missing fields, duplicate detection, special characters in names
- **Calendar Edge Cases** - All-day events, multi-day events, overlapping events, midnight crossing
- **Result Edge Cases** - Zero results, max results, exactly page size, pagination boundaries

### Regression Detection

```bash
npm run perf:regression
```

Tests for performance regression and baseline comparisons:

- **Baseline Comparisons** - Compare current performance against stored baselines
- **Delta Tracking** - Track performance changes across runs
- **Memory Regression** - Detect memory usage regressions
- **Throughput Regression** - Ensure throughput doesn't degrade
- **Latency Percentiles** - Monitor P50, P75, P90, P95, P99 trends
- **Baseline Generation** - Generate new baselines for future comparison
- **Regression Reports** - Comprehensive pass/fail reports

### LanceDB Performance

```bash
npm run perf:lancedb
```

Tests for vector database operations:

- **Table Creation** - Create tables with various schemas
- **Bulk Insert** - Insert 100, 1000+ records efficiently
- **Vector Search** - Search small and large tables
- **Filtered Search** - Filter by source type, complex expressions
- **Delete Operations** - Single and bulk deletes
- **Update Operations** - Record updates
- **Connection Pooling** - Connection reuse and concurrency
- **Memory Efficiency** - Memory during inserts and searches
- **Index Operations** - Vector index creation
- **Query Builder** - Complex query chain performance

### Background Indexing

```bash
npm run perf:background
```

Tests for system impact during background indexing:

- **System Impact** - CPU usage, memory impact, event loop blocking
- **Concurrent Operations** - Handle searches and tool calls during indexing
- **Priority Handling** - Prioritize user requests over indexing
- **Incremental Indexing** - Process updates quickly
- **Batch Size Optimization** - Find optimal batch sizes
- **Throttling Effectiveness** - Limit resource usage with throttling
- **Progress Tracking** - Track indexing progress efficiently
- **Resume After Interruption** - Resume indexing after failures
- **Mixed Source Indexing** - Handle multiple sources concurrently
- **Resource Cleanup** - Cleanup resources after indexing

### Date Parsing Performance

```bash
npm run perf:dates
```

Tests for chrono-node date parsing:

- **Simple Expressions** - "today", "tomorrow", "yesterday"
- **Relative Dates** - "next week", "in 3 days", "2 weeks ago"
- **Absolute Formats** - MM/DD/YYYY, YYYY-MM-DD, day names
- **Date Ranges** - "from X to Y", "between X and Y"
- **Natural Language** - Email-style queries, complex expressions
- **Batch Parsing** - Parse 100+ dates efficiently
- **Invalid/Edge Cases** - Non-date text, ambiguous dates, long text
- **Timezone Handling** - Parse dates with timezone info
- **Mac Absolute Time** - Convert Mac timestamps quickly
- **Date Formatting** - Format dates for display
- **Date Comparison** - Sort and filter dates by range

## Performance Thresholds

### Target Latencies

| Operation | Target P95 |
|-----------|-----------|
| Tool dispatch | < 10ms |
| Single search | < 100ms |
| Smart search (cross-source) | < 150ms |
| List tools | < 10ms |
| Recent items | < 50ms |
| Date filtering | < 50ms |

### Target Throughput

| Operation | Target |
|-----------|--------|
| Email indexing | > 20 emails/sec |
| Embedding generation | > 100 texts/sec |
| Search operations | > 100 ops/sec |

### Memory Limits

| Metric | Limit |
|--------|-------|
| Peak heap during indexing | < 500MB |
| Memory growth per 100 ops | < 30MB |
| Retained after cleanup | < 50MB |

## Test Output

Each test suite produces:
- Latency percentiles (min, p50, p75, p90, p95, p99, max)
- Throughput measurements
- Memory usage tracking
- Latency histograms
- Comparison tables

Example output:
```
============================================================
  Search Performance - Performance Report
============================================================

📊 Vector search 10k records
   Iterations: 20 (warmup: 5)
   Mean:   12.34ms
   Median: 11.89ms
   Min:    8.21ms
   Max:    18.45ms
   P95:    16.23ms
   StdDev: 2.34ms

📊 Full search pipeline
   Iterations: 20 (warmup: 5)
   Mean:   45.67ms
   ...
```

## Writing Performance Tests

### Using the Benchmark Helper

```javascript
import { benchmark, PerformanceReporter } from './helpers/benchmark.js'

const result = await benchmark(
  async () => {
    // Code to measure
    await yourFunction()
  },
  {
    name: 'My benchmark',
    iterations: 20,
    warmup: 5,
    collectMemory: true
  }
)

expect(result.p95).toBeLessThan(100)
```

### Using the Performance Reporter

```javascript
const reporter = new PerformanceReporter('My Tests')

// Add results
reporter.addResult(result1)
reporter.addResult(result2)

// Print report
reporter.report()
```

### Using the Latency Histogram

```javascript
import { LatencyHistogram } from './helpers/benchmark.js'

const histogram = new LatencyHistogram(5) // 5ms buckets

for (let i = 0; i < 100; i++) {
  const start = performance.now()
  await operation()
  histogram.record(performance.now() - start)
}

histogram.printHistogram()
```

## CI Integration

Add to your CI pipeline:

```yaml
# GitHub Actions example
- name: Run performance tests
  run: npm run perf:quick

- name: Run full performance suite
  run: npm run perf:full
  timeout-minutes: 5
```

## Test Files Structure

```
tests/perf/
├── helpers/
│   ├── benchmark.js       # Benchmarking utilities
│   ├── data-generators.js # Test data generation
│   └── mocks.js           # Performance-optimized mocks
├── indexing.perf.test.js  # Indexing tests
├── search.perf.test.js    # Search tests
├── tools.perf.test.js     # Tool tests
├── mcp-server.perf.test.js # Server tests
├── embedding.perf.test.js # Embedding tests
├── datasources.perf.test.js # Data source tests
├── memory.perf.test.js    # Memory tests
├── stress.perf.test.js    # Stress tests
├── negative.perf.test.js  # Negative/error path tests
├── edge-cases.perf.test.js # Edge case tests
├── regression.perf.test.js # Regression detection tests
├── lancedb.perf.test.js   # LanceDB vector database tests
├── background-indexing.perf.test.js # Background indexing tests
├── date-parsing.perf.test.js # Date parsing tests
└── README.md              # This file
```

## Troubleshooting

### Tests timing out

Increase timeout:
```bash
npm run perf:stress -- --testTimeout=300000
```

### Memory issues

Run with GC exposure:
```bash
node --expose-gc node_modules/.bin/vitest run tests/perf
```

### Inconsistent results

- Increase iterations: `iterations: 50`
- Increase warmup: `warmup: 10`
- Close other applications
- Disable CPU throttling
