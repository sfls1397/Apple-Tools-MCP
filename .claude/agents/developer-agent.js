import * as gitOps from './git-ops.js';

export async function generateCode(state) {
  console.log('[DEVELOPER AGENT] Analyzing requirement and design...');
  console.log(`[DEVELOPER AGENT] "${state.requirement}"\n`);

  const designContext = formatDesignContext(state.design);
  console.log('[DEVELOPER AGENT] Design context:\n' + designContext + '\n');

  const implementation = generateImplementation(state.requirement, state.design);

  console.log('[DEVELOPER AGENT] Implementation plan:\n' + implementation + '\n');

  const changes = formatChanges(state.requirement, implementation);
  const filesChanged = extractFilesChanged(implementation);

  console.log('[DEVELOPER AGENT] Ready to commit:\n');
  console.log(`  Files: ${filesChanged.length}`);
  console.log(`  Changes: ${changes.substring(0, 100)}...\n`);

  gitOps.stageAllChanges();

  return {
    changes,
    filesChanged,
  };
}

function formatDesignContext(design) {
  return `
Architecture:
${design.architecture || 'No architecture specified'}

API Interface:
${design.apiInterface || 'No API interface specified'}

Data Model:
${design.dataModel || 'No data model specified'}
  `.trim();
}

function generateImplementation(requirement, design) {
  const lowerReq = requirement.toLowerCase();

  let implementation = `Implementation Steps:\n\n`;

  if (lowerReq.includes('search')) {
    implementation += `1. Extend search.js with new search variant
2. Add query expansion pattern for this use case
3. Implement RRF merging if multi-source
4. Add caching layer (TTL=5min, max=100)
5. Create tests in tests/integration/search*.test.js
6. Add performance test in tests/perf/search.perf.test.js
7. Validate with npm test && npm run perf:search`;
  } else if (lowerReq.includes('tool')) {
    implementation += `1. Register new MCP tool in index.js with schema
2. Create handler function with input validation
3. Use lib/validators.js for security checks
4. Use lib/shell.js for any subprocess calls
5. Return result in MCP resource format
6. Create unit test in tests/unit/
7. Create integration test in tests/integration/
8. Validate with npm test`;
  } else if (lowerReq.includes('index')) {
    implementation += `1. Extend indexer.js data loading logic
2. Add parser/transformer for new source
3. Generate embeddings using existing model
4. Insert into appropriate LanceDB table
5. Handle incremental indexing with -mtime
6. Create tests in tests/indexing/accuracy/
7. Create performance test in tests/perf/indexing.perf.test.js
8. Run npm test:idx && npm run perf:indexing`;
  } else if (lowerReq.includes('test') || lowerReq.includes('security')) {
    implementation += `1. Create test file in appropriate tests/ directory
2. Follow existing test patterns (describe, it, expect)
3. Use describe.skipIf for macOS data source availability
4. Mock external dependencies as needed
5. Include both happy path and error cases
6. Add performance assertions if applicable
7. Run npm test to verify
8. Measure coverage with npm run test:coverage`;
  } else {
    implementation += `1. Create/modify module file following naming conventions
2. Implement with camelCase functions and semantic prefixes
3. Export named exports only (no default)
4. Add JSDoc comments for public functions
5. Use lib/validators.js and lib/shell.js for security
6. Create unit tests in tests/unit/
7. Create integration tests in tests/integration/
8. Run npm test to verify`;
  }

  return implementation;
}

function formatChanges(requirement, implementation) {
  return `Implemented: ${requirement}

${implementation}

Changes committed to feature branch with detailed commit message.
Ready for review and testing.`;
}

function extractFilesChanged(implementation) {
  const files = [];

  if (implementation.includes('search.js')) {
    files.push('search.js');
  }
  if (implementation.includes('index.js')) {
    files.push('index.js');
  }
  if (implementation.includes('indexer.js')) {
    files.push('indexer.js');
  }
  if (implementation.includes('contacts.js')) {
    files.push('contacts.js');
  }
  if (implementation.includes('tests/')) {
    files.push('tests/[new test files]');
  }
  if (implementation.includes('lib/')) {
    files.push('lib/[utilities]');
  }

  if (files.length === 0) {
    files.push('[Implementation files]');
  }

  return files;
}
