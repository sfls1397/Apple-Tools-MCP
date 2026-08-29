import * as pipelineState from './pipeline-state.js';
import * as approvalHandler from './approval-handler.js';
import * as gitOps from './git-ops.js';
import * as designAgent from './design-agent.js';
import * as developerAgent from './developer-agent.js';
import * as qaAgent from './qa-agent.js';

export async function runTeamPipeline(requirement, options = {}) {
  const { autonomous = false } = options;
  const approvalMode = autonomous ? 'AUTONOMOUS' : 'MANUAL';

  console.log(`\n[ORCHESTRATOR] Starting team pipeline: "${requirement}"`);
  console.log(`[ORCHESTRATOR] Mode: ${approvalMode}\n`);

  const state = pipelineState.createState(requirement, approvalMode);
  console.log(`[ORCHESTRATOR] Session ID: ${state.sessionId}\n`);

  try {
    await executeDesignStage(state);
    if (state.status === 'FAILED') return state;

    await executeDevelopmentStage(state);
    if (state.status === 'FAILED') return state;

    await executeQaStage(state);

    if (state.status === 'COMPLETED' || state.status === 'QA') {
      await finalizePipeline(state);
    }

    return state;
  } catch (error) {
    console.error(`[ORCHESTRATOR] Pipeline error: ${error.message}`);
    state.status = 'FAILED';
    pipelineState.saveState(state);
    throw error;
  }
}

async function executeDesignStage(state) {
  console.log('[ORCHESTRATOR] >>> DESIGN STAGE\n');
  pipelineState.advanceStage(state, 'DESIGN');

  const designOutput = await designAgent.generateDesign(state.requirement);

  pipelineState.updateStateStage(state, 'design', {
    architecture: designOutput.architecture,
    apiInterface: designOutput.apiInterface,
    dataModel: designOutput.dataModel,
    status: 'PENDING_REVIEW',
  });

  const summary = approvalHandler.formatApprovalSummary('design', state.design);
  const approved = await requestApproval(state, 'design', summary);

  if (!approved) {
    console.log('[DESIGN] Revision requested - restarting design stage\n');
    state.design.status = 'REJECTED';
    pipelineState.saveState(state);
    state.status = 'FAILED';
    return;
  }

  state.design.status = 'APPROVED';
  pipelineState.saveState(state);

  const commitHash = gitOps.createDesignCommit(state, state.design);
  if (commitHash) {
    console.log(`[DESIGN] Committed: ${commitHash.substring(0, 8)}\n`);
  }
}

async function executeDevelopmentStage(state) {
  console.log('[ORCHESTRATOR] >>> DEVELOPMENT STAGE\n');
  pipelineState.advanceStage(state, 'DEVELOPMENT');

  const devOutput = await developerAgent.generateCode(state);

  pipelineState.updateStateStage(state, 'development', {
    changes: devOutput.changes,
    filesChanged: devOutput.filesChanged,
    status: 'PENDING_REVIEW',
  });

  const summary = approvalHandler.formatApprovalSummary('development', state.development);
  const approved = await requestApproval(state, 'development', summary);

  if (!approved) {
    console.log('[DEVELOPMENT] Revision requested - restarting development stage\n');
    state.development.status = 'REJECTED';
    pipelineState.saveState(state);
    state.status = 'FAILED';
    return;
  }

  state.development.status = 'APPROVED';
  pipelineState.saveState(state);

  const commitHash = gitOps.createDevelopmentCommit(state, state.development);
  if (commitHash) {
    state.development.commitHash = commitHash;
    console.log(`[DEVELOPMENT] Committed: ${commitHash.substring(0, 8)}\n`);
    pipelineState.saveState(state);
  }
}

async function executeQaStage(state) {
  console.log('[ORCHESTRATOR] >>> QA STAGE\n');
  pipelineState.advanceStage(state, 'QA');

  const qaOutput = await qaAgent.runQualityAssurance();

  pipelineState.updateStateStage(state, 'qa', {
    npmTestResults: qaOutput.npmTest,
    regressionResults: qaOutput.regression,
    securityReviewResults: qaOutput.security,
    performanceBenchmarks: qaOutput.performance,
    status: 'PENDING_REVIEW',
  });

  const summary = approvalHandler.formatApprovalSummary('qa', state.qa);
  const approved = await requestApproval(state, 'qa', summary);

  if (!approved) {
    console.log('[QA] Issues noted - restarting development stage for fixes\n');
    state.qa.status = 'REJECTED';
    pipelineState.saveState(state);
    state.status = 'DEVELOPMENT';
    return;
  }

  state.qa.status = 'APPROVED';
  pipelineState.advanceStage(state, 'COMPLETED');
  pipelineState.saveState(state);

  const commitHash = gitOps.createQaCommit(state, state.qa);
  if (commitHash) {
    console.log(`[QA] Committed: ${commitHash.substring(0, 8)}\n`);
  }
}

async function requestApproval(state, stage, summary) {
  if (state.approvalMode === 'AUTONOMOUS') {
    console.log(`[${stage.toUpperCase()}] Auto-approving (autonomous mode)\n`);
    return true;
  }

  const approval = await approvalHandler.requestUserApproval(stage, summary);

  if (approval.approved) {
    console.log(`[${stage.toUpperCase()}] ✓ Approved\n`);
    return true;
  } else {
    console.log(`[${stage.toUpperCase()}] ✗ Rejected\n`);
    if (approval.notes) {
      pipelineState.updateStateStage(state, stage, { reviewNotes: approval.notes });
    }
    return false;
  }
}

async function finalizePipeline(state) {
  console.log('[ORCHESTRATOR] >>> FINALIZING\n');

  const featureBranch = `team/session-${state.sessionId}`;

  try {
    gitOps.mergeBranch(featureBranch, 'main');
    console.log(`[ORCHESTRATOR] Merged ${featureBranch} into main\n`);

    gitOps.deleteBranch(featureBranch);
    console.log(`[ORCHESTRATOR] Cleaned up feature branch\n`);

    state.status = 'COMPLETED';
    pipelineState.saveState(state);

    console.log('[ORCHESTRATOR] ✓ Pipeline completed successfully\n');
    console.log(`Session: ${state.sessionId}`);
    console.log(`Requirement: ${state.requirement}\n`);
  } catch (error) {
    console.error(`[ORCHESTRATOR] Finalization error: ${error.message}`);
    state.status = 'FAILED';
    pipelineState.saveState(state);
    throw error;
  }
}

export async function resumePipeline(sessionId, options = {}) {
  console.log(`[ORCHESTRATOR] Resuming session: ${sessionId}\n`);

  const state = pipelineState.loadState(sessionId);
  console.log(`[ORCHESTRATOR] Status: ${state.status}\n`);

  try {
    if (state.status === 'DESIGN' || state.design.status !== 'APPROVED') {
      await executeDesignStage(state);
      if (state.status === 'FAILED') return state;
    }

    if (state.status === 'DEVELOPMENT' || state.development.status !== 'APPROVED') {
      await executeDevelopmentStage(state);
      if (state.status === 'FAILED') return state;
    }

    if (state.status === 'QA' || state.qa.status !== 'APPROVED') {
      await executeQaStage(state);
    }

    if (state.status === 'COMPLETED' || state.status === 'QA') {
      await finalizePipeline(state);
    }

    return state;
  } catch (error) {
    console.error(`[ORCHESTRATOR] Resume error: ${error.message}`);
    state.status = 'FAILED';
    pipelineState.saveState(state);
    throw error;
  }
}

export async function getPipelineStatus(sessionId) {
  const state = pipelineState.loadState(sessionId);
  const history = pipelineState.getSessionHistory(sessionId);

  console.log('\n' + '='.repeat(80));
  console.log('PIPELINE STATUS');
  console.log('='.repeat(80));
  console.log(JSON.stringify(history, null, 2));
  console.log('='.repeat(80) + '\n');

  return history;
}

export async function listPipelines() {
  const sessions = pipelineState.listSessions();
  if (sessions.length === 0) {
    console.log('[ORCHESTRATOR] No pipeline sessions found\n');
    return [];
  }

  console.log('[ORCHESTRATOR] Recent pipeline sessions:\n');
  sessions.forEach((sessionId) => {
    const history = pipelineState.getSessionHistory(sessionId);
    console.log(`  ${sessionId.substring(0, 8)}... - ${history.requirement} [${history.status}]`);
  });
  console.log();

  return sessions;
}
