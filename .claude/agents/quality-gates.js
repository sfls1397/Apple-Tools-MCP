import { spawnSync } from 'child_process';

const REPO_ROOT = process.cwd();

function safeNpm(args, description) {
  const result = spawnSync('npm', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 300000,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    description,
  };
}

export async function runNpmTests(options = {}) {
  console.log('[QA] Running npm test...');
  const start = Date.now();

  const result = safeNpm(['test'], 'npm test');
  const duration = Date.now() - start;

  const passed = result.status === 0;
  let testCount = 0;

  const testMatch = result.stdout.match(/(\d+)\s+passed/i);
  if (testMatch) {
    testCount = parseInt(testMatch[1], 10);
  }

  return {
    passed,
    details: {
      duration,
      testCount,
      output: result.stdout.slice(-500),
    },
    duration,
    warnings: passed ? [] : ['Tests failed'],
    failureReason: passed ? null : 'npm test exited with non-zero status',
  };
}

export async function detectRegressions(baseline = null) {
  console.log('[QA] Checking for regressions...');

  if (!baseline) {
    return {
      passed: true,
      details: { message: 'No baseline - skipping regression check' },
      duration: 0,
      warnings: [],
      failureReason: null,
    };
  }

  const start = Date.now();
  const result = safeNpm(['run', 'perf:quick'], 'perf:quick benchmark');
  const duration = Date.now() - start;

  const passed = result.status === 0;

  return {
    passed,
    details: {
      baseline,
      current: result.stdout.slice(-300),
      status: passed ? 'PASS' : 'WARN',
    },
    duration,
    warnings: passed ? [] : ['Possible performance regression'],
    failureReason: passed ? null : 'Performance degradation detected',
  };
}

export async function runSecurityReview() {
  console.log('[QA] Running security review...');
  const start = Date.now();

  const result = safeNpm(['run', 'test:security'], 'test:security');
  const duration = Date.now() - start;

  const passed = result.status === 0;
  let issues = [];

  if (!passed && result.stdout) {
    const lines = result.stdout.split('\n');
    issues = lines.filter(
      (line) =>
        line.includes('FAIL') ||
        line.includes('injection') ||
        line.includes('vulnerability'),
    );
  }

  return {
    passed,
    details: {
      issues: issues.slice(0, 10),
      output: result.stdout.slice(-300),
    },
    duration,
    warnings: passed ? [] : ['Security issues detected'],
    failureReason: passed ? null : 'Security tests failed',
  };
}

export async function runPerformanceBenchmarks() {
  console.log('[QA] Running performance benchmarks...');
  const start = Date.now();

  const result = safeNpm(['run', 'perf:quick'], 'performance benchmarks');
  const duration = Date.now() - start;

  const passed = result.status === 0;
  let summary = 'Benchmarks completed';

  if (result.stdout.includes('FAIL')) {
    summary = 'Performance tests failed';
  } else if (result.stdout.includes('pass')) {
    const match = result.stdout.match(/(\d+)\s+pass/i);
    if (match) {
      summary = `${match[1]} performance tests passed`;
    }
  }

  return {
    passed,
    details: {
      summary,
      output: result.stdout.slice(-300),
    },
    duration,
    warnings: passed ? [] : ['Performance benchmark issues'],
    failureReason: passed ? null : 'Performance benchmarks failed',
  };
}

export async function runAllQualityGates() {
  console.log('\n[QA] Running all quality gates...\n');

  const results = {
    npmTest: await runNpmTests(),
    regression: await detectRegressions(),
    security: await runSecurityReview(),
    performance: await runPerformanceBenchmarks(),
  };

  const allPassed =
    results.npmTest.passed &&
    results.regression.passed &&
    results.security.passed &&
    results.performance.passed;

  return {
    passed: allPassed,
    summary: {
      npmTest: results.npmTest.passed ? '✓ PASS' : '✗ FAIL',
      regression: results.regression.passed ? '✓ PASS' : '⚠ WARN',
      security: results.security.passed ? '✓ PASS' : '✗ FAIL',
      performance: results.performance.passed ? '✓ PASS' : '⚠ WARN',
    },
    details: results,
    totalDuration:
      results.npmTest.duration +
      results.regression.duration +
      results.security.duration +
      results.performance.duration,
  };
}
