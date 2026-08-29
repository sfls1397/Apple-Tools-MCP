import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

export async function requestUserApproval(stage, summary, options = {}) {
  const { timeout = 3600000 } = options;

  console.log('\n' + '='.repeat(80));
  console.log(`[${stage.toUpperCase()}] APPROVAL REQUIRED`);
  console.log('='.repeat(80));
  console.log(summary);
  console.log('='.repeat(80) + '\n');

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      console.warn(`[WARNING] Approval timeout after ${timeout / 60000} minutes`);
      resolve('timeout');
    }, timeout);
  });

  const approvalPromise = question('Do you approve? (yes/no/details): ');

  const response = await Promise.race([approvalPromise, timeoutPromise]);

  if (response === 'timeout') {
    return { approved: false, notes: 'Timeout - no response from user' };
  }

  const lower = response.toLowerCase().trim();
  if (lower === 'yes' || lower === 'y') {
    return { approved: true, notes: null };
  } else if (lower === 'no' || lower === 'n') {
    const feedback = await question('Provide feedback for revision: ');
    return { approved: false, notes: feedback };
  } else {
    return { approved: false, notes: response };
  }
}

export async function skipApprovalIfAutonomous(approvalMode) {
  return approvalMode === 'AUTONOMOUS';
}

export function formatApprovalSummary(stage, data) {
  let summary = '';

  if (stage === 'design') {
    summary = `
Architecture Decision:
${data.architecture || '[No architecture details]'}

API Interface:
${data.apiInterface || '[No API specification]'}

Data Model:
${data.dataModel || '[No data model]'}
    `.trim();
  }

  if (stage === 'development') {
    summary = `
Changes Implemented:
${data.changes || '[No changes description]'}

Files Modified:
${(data.filesChanged || []).map((f) => `  - ${f}`).join('\n') || '  [No files changed]'}
    `.trim();
  }

  if (stage === 'qa') {
    summary = `
Test Results:
  npm test: ${data.npmTestResults?.passed ? `✓ PASSED (${data.npmTestResults.passed} tests)` : '✗ FAILED'}

Regression Analysis:
  ${data.regressionResults?.status || 'Pending'}

Security Review:
  ${data.securityReviewResults?.status || 'Pending'}

Performance Benchmarks:
  ${data.performanceBenchmarks?.summary || 'Pending'}
    `.trim();
  }

  return summary;
}

export async function closeApprovalHandler() {
  return new Promise((resolve) => {
    rl.close();
    resolve();
  });
}
