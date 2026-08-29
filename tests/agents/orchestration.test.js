import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as orchestrator from '../../.claude/agents/orchestrator.js';
import * as pipelineState from '../../.claude/agents/pipeline-state.js';
import fs from 'fs';
import path from 'path';

const TEST_SESSION_DIR = path.join(process.env.HOME, '.apple-tools-mcp', 'team-sessions');

describe('Team Orchestrator', () => {
  beforeEach(() => {
    // Clean up test sessions
    if (fs.existsSync(TEST_SESSION_DIR)) {
      const files = fs.readdirSync(TEST_SESSION_DIR);
      files.forEach((file) => {
        if (file.startsWith('test-')) {
          fs.unlinkSync(path.join(TEST_SESSION_DIR, file));
        }
      });
    }
  });

  describe('Pipeline State Management', () => {
    it('creates a new pipeline state', () => {
      const state = pipelineState.createState('Test requirement', 'MANUAL');

      expect(state).toBeDefined();
      expect(state.requirement).toBe('Test requirement');
      expect(state.status).toBe('DESIGN');
      expect(state.approvalMode).toBe('MANUAL');
    });

    it('persists and loads pipeline state', () => {
      const state = pipelineState.createState('Test requirement', 'MANUAL');
      const loaded = pipelineState.loadState(state.sessionId);

      expect(loaded.sessionId).toBe(state.sessionId);
      expect(loaded.requirement).toBe('Test requirement');
    });

    it('updates stage status', () => {
      const state = pipelineState.createState('Test', 'MANUAL');

      pipelineState.updateStateStage(state, 'design', {
        architecture: 'Test architecture',
        status: 'APPROVED',
      });

      const loaded = pipelineState.loadState(state.sessionId);
      expect(loaded.design.architecture).toBe('Test architecture');
      expect(loaded.design.status).toBe('APPROVED');
    });

    it('advances pipeline stage', () => {
      const state = pipelineState.createState('Test', 'MANUAL');

      pipelineState.advanceStage(state, 'DEVELOPMENT');

      const loaded = pipelineState.loadState(state.sessionId);
      expect(loaded.status).toBe('DEVELOPMENT');
      expect(loaded.stage).toBe(2);
    });

    it('lists all sessions', () => {
      const state1 = pipelineState.createState('Requirement 1', 'MANUAL');
      const state2 = pipelineState.createState('Requirement 2', 'MANUAL');

      const sessions = pipelineState.listSessions();

      expect(sessions).toContain(state1.sessionId);
      expect(sessions).toContain(state2.sessionId);
    });

    it('gets session history', () => {
      const state = pipelineState.createState('Test requirement', 'MANUAL');

      pipelineState.updateStateStage(state, 'design', {
        architecture: 'Test',
        status: 'APPROVED',
      });

      const history = pipelineState.getSessionHistory(state.sessionId);

      expect(history.requirement).toBe('Test requirement');
      expect(history.status).toBe('DESIGN');
      expect(history.stageHistory.design.status).toBe('APPROVED');
    });

    it('deletes session state', () => {
      const state = pipelineState.createState('Test', 'MANUAL');

      pipelineState.deleteState(state.sessionId);

      expect(() => pipelineState.loadState(state.sessionId)).toThrow();
    });
  });

  describe('Approval Mode', () => {
    it('respects autonomous mode flag', () => {
      const state = pipelineState.createState('Test', 'AUTONOMOUS');

      expect(state.approvalMode).toBe('AUTONOMOUS');
    });

    it('defaults to manual mode', () => {
      const state = pipelineState.createState('Test');

      expect(state.approvalMode).toBe('MANUAL');
    });
  });

  describe('Session Recovery', () => {
    it('can resume a partial pipeline', () => {
      const state = pipelineState.createState('Test', 'AUTONOMOUS');

      pipelineState.updateStateStage(state, 'design', {
        architecture: 'Test',
        status: 'APPROVED',
      });

      pipelineState.advanceStage(state, 'DEVELOPMENT');

      const loaded = pipelineState.loadState(state.sessionId);
      expect(loaded.status).toBe('DEVELOPMENT');
      expect(loaded.design.status).toBe('APPROVED');
    });

    it('marks stage as failed on rejection', () => {
      const state = pipelineState.createState('Test', 'MANUAL');

      pipelineState.updateStateStage(state, 'design', {
        architecture: 'Test',
        status: 'REJECTED',
        reviewNotes: 'Needs revision',
      });

      const loaded = pipelineState.loadState(state.sessionId);
      expect(loaded.design.status).toBe('REJECTED');
      expect(loaded.design.reviewNotes).toBe('Needs revision');
    });
  });

  describe('Error Handling', () => {
    it('throws on invalid session ID', () => {
      expect(() => pipelineState.loadState('invalid-session-id')).toThrow(
        /Session not found/
      );
    });

    it('handles unknown stage gracefully', () => {
      const state = pipelineState.createState('Test', 'MANUAL');

      expect(() =>
        pipelineState.updateStateStage(state, 'unknown', { status: 'APPROVED' })
      ).toThrow();
    });
  });
});
