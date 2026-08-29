import * as qualityGates from './quality-gates.js';

export async function runQualityAssurance() {
  console.log('[QA AGENT] Starting quality assurance testing\n');

  const results = await qualityGates.runAllQualityGates();

  console.log('[QA AGENT] QA Summary:\n');
  console.log(`  npm test: ${results.summary.npmTest}`);
  console.log(`  Regression: ${results.summary.regression}`);
  console.log(`  Security: ${results.summary.security}`);
  console.log(`  Performance: ${results.summary.performance}`);
  console.log(`\n  Total Duration: ${Math.round(results.totalDuration / 1000)}s\n`);

  return {
    npmTest: formatTestResult(results.details.npmTest),
    regression: formatRegressionResult(results.details.regression),
    security: formatSecurityResult(results.details.security),
    performance: formatPerformanceResult(results.details.performance),
    allPassed: results.passed,
  };
}

function formatTestResult(result) {
  return {
    status: result.passed ? 'PASS' : 'FAIL',
    testCount: result.details.testCount,
    duration: result.duration,
    output: result.details.output,
    failures: result.warnings,
  };
}

function formatRegressionResult(result) {
  return {
    status: result.passed ? 'PASS' : 'WARN',
    baseline: result.details.baseline,
    current: result.details.current,
    duration: result.duration,
    warnings: result.warnings,
  };
}

function formatSecurityResult(result) {
  return {
    status: result.passed ? 'PASS' : 'FAIL',
    issuesFound: result.details.issues.length,
    issues: result.details.issues,
    duration: result.duration,
    failures: result.warnings,
  };
}

function formatPerformanceResult(result) {
  return {
    status: result.passed ? 'PASS' : 'WARN',
    summary: result.details.summary,
    duration: result.duration,
    output: result.details.output,
    warnings: result.warnings,
  };
}
