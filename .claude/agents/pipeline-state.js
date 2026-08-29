import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(process.env.HOME, '.apple-tools-mcp', 'team-sessions');

function ensureStateDirExists() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function getStateFilePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

export function createState(requirement, approvalMode = 'MANUAL') {
  const sessionId = randomUUID();
  const state = {
    sessionId,
    status: 'DESIGN',
    stage: 1,
    timestamp: new Date().toISOString(),
    requirement,
    approvalMode,

    design: {
      architecture: null,
      apiInterface: null,
      dataModel: null,
      status: 'PENDING',
      reviewNotes: null,
      timestamp: null,
    },

    development: {
      commitHash: null,
      filesChanged: [],
      changes: null,
      status: 'PENDING',
      reviewNotes: null,
      timestamp: null,
    },

    qa: {
      npmTestResults: null,
      regressionResults: null,
      securityReviewResults: null,
      performanceBenchmarks: null,
      status: 'PENDING',
      reviewNotes: null,
      timestamp: null,
    },
  };

  saveState(state);
  return state;
}

export function saveState(state) {
  ensureStateDirExists();
  const filePath = getStateFilePath(state.sessionId);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function loadState(sessionId) {
  const filePath = getStateFilePath(sessionId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

export function deleteState(sessionId) {
  const filePath = getStateFilePath(sessionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function listSessions() {
  ensureStateDirExists();
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => f.replace('.json', '')).sort();
}

export function getSessionHistory(sessionId) {
  const state = loadState(sessionId);
  return {
    sessionId: state.sessionId,
    requirement: state.requirement,
    status: state.status,
    stage: state.stage,
    timestamp: state.timestamp,
    approvalMode: state.approvalMode,
    stageHistory: {
      design: {
        status: state.design.status,
        timestamp: state.design.timestamp,
        reviewNotes: state.design.reviewNotes,
      },
      development: {
        status: state.development.status,
        timestamp: state.development.timestamp,
        reviewNotes: state.development.reviewNotes,
        commitHash: state.development.commitHash,
      },
      qa: {
        status: state.qa.status,
        timestamp: state.qa.timestamp,
        reviewNotes: state.qa.reviewNotes,
      },
    },
  };
}

export function updateStateStage(state, stageName, updates) {
  if (!state[stageName]) {
    throw new Error(`Unknown stage: ${stageName}`);
  }
  state[stageName] = {
    ...state[stageName],
    ...updates,
    timestamp: new Date().toISOString(),
  };
  saveState(state);
  return state;
}

export function advanceStage(state, nextStatus) {
  const stageMap = { DESIGN: 1, DEVELOPMENT: 2, QA: 3, COMPLETED: 4, FAILED: 5 };
  state.status = nextStatus;
  state.stage = stageMap[nextStatus] || state.stage;
  saveState(state);
  return state;
}
