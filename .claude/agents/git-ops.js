import { spawnSync } from 'child_process';
import path from 'path';

const REPO_ROOT = process.cwd();

function safeGit(args, description) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`Git error (${description}): ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Git command failed (${description}): ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

export function getCurrentBranch() {
  return safeGit(['rev-parse', '--abbrev-ref', 'HEAD'], 'get current branch');
}

export function createFeatureBranch(sessionId) {
  const branchName = `team/session-${sessionId}`;
  try {
    safeGit(['checkout', '-b', branchName], `create branch ${branchName}`);
    return branchName;
  } catch (error) {
    throw new Error(`Failed to create feature branch: ${error.message}`);
  }
}

export function switchBranch(branchName) {
  safeGit(['checkout', branchName], `switch to ${branchName}`);
}

export function getChangedFiles() {
  const result = spawnSync('git', ['diff', '--name-only', '--cached'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  if (result.status === 0) {
    return result.stdout
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  }
  return [];
}

export function stageAllChanges() {
  safeGit(['add', '-A'], 'stage all changes');
}

export function createCommit(message) {
  try {
    safeGit(['commit', '-m', message], `create commit: ${message.split('\n')[0]}`);
    const hash = safeGit(['rev-parse', 'HEAD'], 'get commit hash');
    return hash;
  } catch (error) {
    if (error.message.includes('nothing to commit')) {
      console.log('[INFO] No changes to commit');
      return null;
    }
    throw error;
  }
}

export function createDesignCommit(state, designContent) {
  const message = `design: ${state.requirement.substring(0, 50)}...\n\nArchitecture:\n${designContent.architecture || 'N/A'}\n\nAPI Interface:\n${designContent.apiInterface || 'N/A'}`;

  return createCommit(message);
}

export function createDevelopmentCommit(state, developmentContent) {
  const message = `feat: ${state.requirement.substring(0, 50)}...\n\n${developmentContent.changes || 'Implementation'}`;

  return createCommit(message);
}

export function createQaCommit(state, qaResults) {
  const testStatus = qaResults.npmTestResults?.passed ? 'PASS' : 'FAIL';
  const message = `test: qa approval for ${state.requirement.substring(0, 50)}...\n\nTest Status: ${testStatus}\nRegression: ${qaResults.regressionResults?.status || 'N/A'}\nSecurity: ${qaResults.securityReviewResults?.status || 'N/A'}`;

  return createCommit(message);
}

export function mergeBranch(sourceBranch, targetBranch = 'main') {
  switchBranch(targetBranch);
  safeGit(['merge', '--no-ff', sourceBranch], `merge ${sourceBranch} into ${targetBranch}`);
  const hash = safeGit(['rev-parse', 'HEAD'], 'get merge commit hash');
  return hash;
}

export function rollbackCommit(commitHash) {
  safeGit(['revert', '--no-edit', commitHash], `revert ${commitHash}`);
}

export function deleteBranch(branchName) {
  try {
    safeGit(['branch', '-D', branchName], `delete branch ${branchName}`);
  } catch (error) {
    console.warn(`Could not delete branch ${branchName}: ${error.message}`);
  }
}

export function getCommitDiff(commitHash) {
  return safeGit(['show', commitHash], `get diff for ${commitHash}`);
}

export function getLastCommitMessage() {
  return safeGit(['log', '-1', '--pretty=%B'], 'get last commit message');
}

export function getRepositoryStatus() {
  const status = safeGit(['status', '--porcelain'], 'get repo status');
  return {
    isDirty: status.length > 0,
    status,
  };
}
