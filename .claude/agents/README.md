# Multi-Agent Team System

A coordinated Design → Developer → QA pipeline for building features on the apple-tools-mcp project.

## Quick Start

```bash
/team "Add user authentication to the API"
/team "Optimize search performance" --autonomous
/team --resume <sessionId>
/team --status <sessionId>
/team --list
```

## Architecture

### Components

1. **Orchestrator** (`orchestrator.js`) - Manages pipeline state and agent coordination
2. **Design Agent** (`design-agent.js`) - Generates architecture, API design, data models
3. **Developer Agent** (`developer-agent.js`) - Implements code based on design
4. **QA Agent** (`qa-agent.js`) - Runs tests, security review, performance benchmarks
5. **Pipeline State** (`pipeline-state.js`) - Persists session state to disk
6. **Git Operations** (`git-ops.js`) - Manages feature branches and commits
7. **Approval Handler** (`approval-handler.js`) - Handles user review/approval gates
8. **Quality Gates** (`quality-gates.js`) - Runs npm test, perf tests, security scans

### Pipeline Flow

```
User Requirement
      ↓
[DESIGN] Architecture + API Interface + Data Model
      ↓ (approval gate)
[DEVELOPMENT] Implement code changes
      ↓ (approval gate)
[QA] Test suite + Security + Performance checks
      ↓ (approval gate)
[FINALIZE] Merge feature branch to main
      ↓
Complete
```

## Session State

Session state is persisted at `~/.apple-tools-mcp/team-sessions/{sessionId}.json`.

```json
{
  "sessionId": "uuid",
  "status": "DESIGN|DEVELOPMENT|QA|COMPLETED|FAILED",
  "requirement": "user's requirement text",
  "approvalMode": "AUTONOMOUS|MANUAL",
  "design": {
    "architecture": "...",
    "apiInterface": "...",
    "dataModel": "...",
    "status": "PENDING_REVIEW|APPROVED|REJECTED"
  },
  "development": {
    "commitHash": "...",
    "filesChanged": [...],
    "changes": "...",
    "status": "PENDING_REVIEW|APPROVED|REJECTED"
  },
  "qa": {
    "npmTestResults": {...},
    "regressionResults": {...},
    "securityReviewResults": {...},
    "performanceBenchmarks": {...},
    "status": "PENDING_REVIEW|APPROVED|REJECTED"
  }
}
```

## Usage

### Running a Pipeline

```bash
/team "Add OAuth support to authentication"
```

The orchestrator will:
1. Create a session ID
2. Create a feature branch `team/session-{id}`
3. Run Design Agent → request approval
4. Run Developer Agent → request approval
5. Run QA Agent → request approval
6. Merge feature branch to main
7. Return results

### Autonomous Mode

Skip all approval gates:

```bash
/team "Minor documentation fix" --autonomous
```

### Resuming a Session

If a session is interrupted, resume it:

```bash
/team --resume abc123def456
```

The system will detect the last completed stage and resume from there.

### Checking Status

```bash
/team --status abc123def456
```

### Listing Sessions

```bash
/team --list
```

## Quality Gates

The QA stage runs these gates in sequence:

1. **npm test** - Unit and integration test suite
2. **Regressions** - Performance delta check against baseline
3. **Security Review** - Static analysis via `npm run test:security`
4. **Performance** - Run `npm run perf:quick` and compare

All gates must pass for QA approval.

## Design Patterns

### Approval Gates

Each stage pauses for user approval unless `--autonomous` is set:

```javascript
const approval = await requestApproval(state, 'design', summary);
if (!approval) {
  // User rejected - stage marked as FAILED
  state.status = 'FAILED';
  return;
}
```

### State Persistence

State is saved after each significant step:

```javascript
pipelineState.updateStateStage(state, 'design', {
  architecture: output.architecture,
  apiInterface: output.apiInterface,
  dataModel: output.dataModel,
  status: 'PENDING_REVIEW'
});
```

### Git Commits

Each stage creates a separate commit:

```
design:  Add architecture for OAuth
feat:    Implement OAuth provider integration
test:    qa approval for OAuth support
```

## Recovery

If an agent crashes mid-pipeline:

1. Session state file preserves progress
2. Call `/team --resume {sessionId}` to continue
3. System detects last completed stage and resumes

If a stage is rejected after approval, the user can:
- Request revisions (provide feedback during approval)
- Restart that stage (`/team --resume {sessionId}`)

## Extending the System

### Adding a New QA Gate

Edit `quality-gates.js` and add a gate function:

```javascript
export async function runMyNewGate() {
  const result = await runCommand(...);
  return {
    passed: result.status === 0,
    details: {...},
    duration: 1234,
    warnings: [],
    failureReason: null
  };
}
```

Then add to `runAllQualityGates()`:

```javascript
const myGate = await runMyNewGate();
results.myGate = myGate;
```

### Customizing Agent Behavior

Edit agent files (`design-agent.js`, `developer-agent.js`, `qa-agent.js`) to customize the logic for your project.

## Troubleshooting

### Session State Corruption

If state file is corrupted, you can manually fix it at `~/.apple-tools-mcp/team-sessions/{sessionId}.json` or delete it to start a new session.

### Git Conflicts

If merging fails, the feature branch remains on disk and can be manually resolved.

### Approval Timeout

By default, approval requests wait 1 hour. After that, the pipeline pauses and waits for manual approval.

## Implementation Notes

- All subprocess calls use `lib/shell.js` safe wrappers with `shell: false`
- State file writes are atomic (whole-file overwrite)
- Session directory created on first use
- Named exports only (no default exports)
- Follows existing apple-tools-mcp naming conventions

## Files

```
.claude/agents/
├── team.js                 # Skill entry point
├── orchestrator.js         # Pipeline coordinator
├── design-agent.js         # Design generation
├── developer-agent.js      # Code implementation
├── qa-agent.js             # QA orchestration
├── pipeline-state.js       # State persistence
├── approval-handler.js     # Approval logic
├── git-ops.js              # Git operations
├── quality-gates.js        # QA gate runners
└── index.js                # Module exports
```

## Testing

Test files will be located in `tests/agents/` (TBD)

## Future Enhancements

- Parallel agent execution (currently sequential)
- Agent-specific model selection
- Custom quality gate pipeline configuration
- Integration with external CI/CD
- Performance baseline tracking
- Multi-requirement batching
