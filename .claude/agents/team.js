import * as orchestrator from './orchestrator.js';

export async function teamCommand(args) {
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    return;
  }

  if (options.list) {
    await orchestrator.listPipelines();
    return;
  }

  if (options.resume) {
    await orchestrator.resumePipeline(options.resume, { autonomous: options.autonomous });
    return;
  }

  if (options.status) {
    await orchestrator.getPipelineStatus(options.status);
    return;
  }

  if (!options.requirement) {
    console.error('[ERROR] Please provide a requirement: /team "your requirement"');
    printHelp();
    return;
  }

  await orchestrator.runTeamPipeline(options.requirement, { autonomous: options.autonomous });
}

function parseArgs(input) {
  const args = {
    requirement: null,
    autonomous: false,
    resume: null,
    status: null,
    list: false,
    help: false,
  };

  if (!input || typeof input !== 'string') {
    return args;
  }

  const trimmed = input.trim();

  if (trimmed === '--help' || trimmed === '-h') {
    args.help = true;
    return args;
  }

  if (trimmed === '--list' || trimmed === '-l') {
    args.list = true;
    return args;
  }

  if (trimmed.startsWith('--resume ')) {
    args.resume = trimmed.replace('--resume ', '').trim();
    return args;
  }

  if (trimmed.startsWith('--status ')) {
    args.status = trimmed.replace('--status ', '').trim();
    return args;
  }

  const autonomousFlag = trimmed.includes('--autonomous');
  if (autonomousFlag) {
    args.autonomous = true;
  }

  const match = trimmed.match(/"([^"]+)"/);
  if (match) {
    args.requirement = match[1];
  } else {
    const parts = trimmed.split('--autonomous').map((p) => p.trim());
    if (parts[0] && parts[0].length > 0) {
      args.requirement = parts[0];
    }
  }

  return args;
}

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                      /team Command Help                        ║
╚════════════════════════════════════════════════════════════════╝

USAGE:
  /team "Your requirement text"
  /team "Requirement" --autonomous
  /team --resume <sessionId>
  /team --status <sessionId>
  /team --list
  /team --help

DESCRIPTION:
  Orchestrates a Design → Developer → QA pipeline for requirements.
  Each stage commits separately to the repo and pauses for approval
  (unless --autonomous is specified).

EXAMPLES:
  /team "Add user authentication to the API"
  /team "Optimize search performance" --autonomous
  /team --resume abc123def456
  /team --status abc123def456
  /team --list

OPTIONS:
  --autonomous    Skip approval gates and auto-approve all stages
  --resume ID     Resume a previous pipeline session
  --status ID     Show status of a specific session
  --list          List all pipeline sessions
  --help          Show this help message

STAGES:
  1. DESIGN      Generate architecture, API interface, data model
  2. DEVELOP     Implement code based on design
  3. QA          Run tests, security review, performance benchmarks

APPROVAL GATES:
  After each stage, you'll be prompted to:
  - Review the output
  - Approve (yes/no) to proceed
  - Provide feedback if rejected

RESULTS:
  - Each stage creates a separate git commit
  - Final approval merges to main branch
  - Session state saved for resumption

`);
}

export default teamCommand;
