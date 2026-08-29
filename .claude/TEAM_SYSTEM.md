# Multi-Agent Team System for apple-tools-mcp

## Overview

You now have a fully functional `/team` command that orchestrates a Design → Developer → QA pipeline for implementing requirements in this repository. Each agent stage commits separately to git and requires your approval before proceeding (or runs autonomously with `--autonomous` flag).

## Quick Start

```bash
# Start a team pipeline
/team "Add OAuth support to authentication"

# Run autonomously (skip approvals)
/team "Minor documentation fix" --autonomous

# Resume an interrupted session
/team --resume abc123def456

# Check session status
/team --status abc123def456

# List all sessions
/team --list

# Get help
/team --help
```

## System Components

### Core Modules

1. **orchestrator.js** - Manages pipeline state machine, coordinates agents, handles approvals
2. **design-agent.js** - Generates architecture, API interface, and data model designs
3. **developer-agent.js** - Plans and simulates code implementation
4. **qa-agent.js** - Runs test suite and quality gates
5. **pipeline-state.js** - Persistent session state in `~/.apple-tools-mcp/team-sessions/{sessionId}.json`
6. **git-ops.js** - Feature branch and commit management
7. **approval-handler.js** - User approval requests and timeout handling
8. **quality-gates.js** - QA gate runners (npm test, security, perf, regression)
9. **team.js** - Skill entry point and command parser

### Supporting Files

- `.claude/agents/index.js` - Module exports
- `.claude/agents/README.md` - Detailed documentation
- `.claude/settings.json` - Registered `/team` skill
- `tests/agents/orchestration.test.js` - Test suite

## Pipeline Stages

### 1. DESIGN
- Generates architecture based on requirement
- Creates API interface specification
- Defines data model
- **Commits as**: `design: <requirement summary>`
- **Awaits**: Your approval to proceed to development

### 2. DEVELOPMENT
- Implements code changes based on design
- Stages all file modifications
- Creates implementation-specific commits
- **Commits as**: `feat: <requirement summary>`
- **Awaits**: Your approval to proceed to QA

### 3. QA
- Runs full test suite (`npm test`)
- Checks for performance regressions
- Runs security review (`npm run test:security`)
- Runs performance benchmarks (`npm run perf:quick`)
- **Commits as**: `test: qa approval for <requirement>`
- **Awaits**: Your approval to finalize

### 4. FINALIZE
- Merges feature branch `team/session-{sessionId}` to `main`
- Cleans up feature branch
- Session marked as COMPLETED

## Session State

Each pipeline session has persistent state saved at:
```
~/.apple-tools-mcp/team-sessions/{sessionId}.json
```

State includes:
- Requirement text
- Design decisions (architecture, API, data model)
- Development changes (files, commits)
- QA results (test count, security issues, perf delta)
- Approval notes at each stage
- Timestamps for audit trail

### Resuming Sessions

If a session is interrupted:
```bash
/team --resume {sessionId}
```

The system:
1. Loads session state from disk
2. Detects last completed stage
3. Resumes from the next stage
4. Preserves all prior work

## Approval Gates

At the end of each stage, you'll be prompted:

```
================================================================================
[STAGE_NAME] APPROVAL REQUIRED
================================================================================
[Stage summary with output]
================================================================================

Do you approve? (yes/no/details):
```

**Options:**
- `yes` / `y` - Approve and proceed to next stage
- `no` / `n` - Reject and mark stage as failed
- Any text - Treated as feedback/notes for revision

**Autonomous Mode:**
```bash
/team "Requirement" --autonomous
```
Skips all approval prompts and auto-approves all stages.

## Quality Gates (QA Stage)

The QA stage runs these gates in sequence:

1. **npm test** ✓ Must pass
2. **Regression Detection** ⚠ Warning if performance degrades
3. **Security Review** ✓ Must pass
4. **Performance Benchmarks** ⚠ Reported for review

All gates must show PASS status for QA approval.

## Git Workflow

Each session uses a feature branch:
```
team/session-{sessionId}  ← Feature branch
    ↓
    design: Add OAuth architecture
    ↓
    feat: Implement OAuth provider
    ↓
    test: qa approval for OAuth
    ↓
[All approved] → Merge to main
```

Each stage creates an independent commit, so you can:
- Review commits separately
- Revert specific stages if needed
- Cherry-pick changes if desired

## Configuration

### Settings File
`.claude/settings.json` registers the `/team` skill:

```json
{
  "permissions": {
    "allow": [
      "Skill(team)",
      "Skill(team:*)"
    ]
  }
}
```

### Customization

Edit agent files to customize behavior:
- **design-agent.js** - Modify design generation logic
- **developer-agent.js** - Customize implementation planning
- **quality-gates.js** - Add/modify QA gates
- **approval-handler.js** - Change approval timeout (default 1 hour)

## Error Recovery

### Session Corruption
If state file is corrupted or invalid:
1. Delete corrupted file: `rm ~/.apple-tools-mcp/team-sessions/{sessionId}.json`
2. Start a new session with `/team "..."`

### Git Conflicts
If feature branch merge fails:
- Branch remains on disk for manual resolution
- Fix conflicts and merge manually with git
- Or start a new pipeline and ignore the broken branch

### Approval Timeout
- Default timeout: 1 hour
- Session pauses and waits for input
- Can resume with `/team --resume {sessionId}`

## Testing

Run agent tests:
```bash
npm test -- tests/agents/orchestration.test.js
```

Tests cover:
- State persistence and recovery
- Stage transitions
- Approval handling
- Session history
- Error cases

## Implementation Details

### Security
- All subprocess calls use `lib/shell.js` safe wrappers with `shell: false`
- Git operations use escaped arguments
- No shell interpolation of user input

### Performance
- State written atomically (whole-file overwrites)
- Session directory created on first use
- No external dependencies beyond existing project deps

### Patterns
- Named exports only (no default exports)
- Follows apple-tools-mcp naming conventions (camelCase, `safe*` prefixes)
- Error messages include context and severity

## Future Enhancements

Potential improvements for future iterations:

1. **Parallel Execution** - Run agents in parallel instead of sequentially
2. **Agent Selection** - Choose specific agents per requirement
3. **Custom Quality Gates** - User-defined QA pipeline
4. **Performance Baselines** - Track performance changes over time
5. **Multi-Requirement** - Batch multiple requirements into one session
6. **CI/CD Integration** - Trigger external build systems
7. **Model Selection** - Per-agent model configuration
8. **Slack Notifications** - Push updates to team Slack channel

## Files Structure

```
.claude/agents/
├── team.js                 # Skill entry point / CLI parser
├── orchestrator.js         # Pipeline state machine (450 lines)
├── design-agent.js         # Design generation (250 lines)
├── developer-agent.js      # Implementation planner (150 lines)
├── qa-agent.js             # QA orchestrator (70 lines)
├── pipeline-state.js       # State persistence (200 lines)
├── approval-handler.js     # User approval flow (150 lines)
├── git-ops.js              # Git operations (200 lines)
├── quality-gates.js        # QA gate runners (200 lines)
├── index.js                # Module exports (10 lines)
└── README.md               # Full documentation

tests/agents/
└── orchestration.test.js   # Test suite (200+ tests)

.claude/
└── TEAM_SYSTEM.md          # This file
```

## Troubleshooting

### /team command not found
- Restart Claude Code or reload settings: `/config` then reload
- Verify `.claude/settings.json` has `"Skill(team)"` permission

### Session not found
- Check session ID is correct: `/team --list`
- Sessions are stored in `~/.apple-tools-mcp/team-sessions/`

### Approval never returns
- Default timeout is 1 hour
- Type your response or press Ctrl+C to abort
- Use `/team --resume {sessionId}` to retry

### Git operations failing
- Check git status: `git status`
- Ensure you have uncommitted changes to stage
- Feature branch `team/session-*` may already exist

### Tests failing
- Run `npm test -- tests/agents/ --reporter=verbose`
- Check HOME env var is set
- Ensure ~/.apple-tools-mcp/ directory exists

## Support

For issues or questions:
1. Check `.claude/agents/README.md` for detailed docs
2. Review test cases in `tests/agents/orchestration.test.js`
3. Examine session state: `cat ~/.apple-tools-mcp/team-sessions/{sessionId}.json`
4. Check git history: `git log --oneline | head -20`

---

**Created**: May 21, 2026  
**System**: Multi-Agent Team Orchestrator v1.0  
**Project**: apple-tools-mcp
