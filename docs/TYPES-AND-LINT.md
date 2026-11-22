# Types and strict lint

Dev process steps 3 and 4, copied from the Toolbox (`docs/TYPES-AND-LINT.md` there) and the Alexa-Echo-MCP PR 22 and scaled to this repository's JavaScript, Python and shell. Whole kinds of mistakes fail in seconds, before any test runs. Lauren Tan puts lint rules, type systems and compilers in the deterministic layers that come first, and says to start with a lint rule that stops new occurrences and then clean up the old ones.

## What runs

| Tool | Checks | Pinned in |
|---|---|---|
| Ruff | Python bugs: undefined names, unused imports, bad escapes, dead conditions | `.cursor/install-lint.sh` (version and checksum), rules in `.lint/ruff.toml` |
| Pyright | Python types: wrong calls, unknown module attributes, undefined names, Python 3.10 features on the Mini's Python 3.9 | `.lint/package-lock.json`, rules in `pyrightconfig.json` |
| ESLint | JavaScript bugs: undefined names, duplicate keys, unreachable code, unused variables | `.lint/package-lock.json`, rules in `.lint/eslint.config.mjs` |
| TypeScript's checker (`tsc --checkJs`) | Imports that do not resolve, missing exports, typos on Node modules, undefined names, grammar errors | `.lint/package-lock.json`, options in `.lint/tsconfig.json`, Node's types from `@types/node` in the same lock |
| Import check | No file outside `tests/` loads a test or fixture, a worktree, or another repo | `.security/lint.py` |
| Suppression check | No comment turns a checker off (`@ts-nocheck`, `@ts-ignore`, `# pyright:`, `# type: ignore`). Ruff runs with `--ignore-noqa` and ESLint with inline config off, so their comments do nothing | `.security/lint.py` |
| Comment ban | No new code comment in JavaScript, Python or shell, and no new Python docstring that nothing reads ([below](#the-comment-ban)) | `.security/lint.py`; JavaScript read by the TypeScript compiler's own comment ranges, shell by shfmt (version and checksum in `.cursor/install-lint.sh`) |
| ShellCheck | Shell scripts, already in the gate with no findings allowed | `.cursor/install-shellcheck.sh` (unchanged) |

`.security/lint.py gate` is the gate's step "Types and strict lint (Ruff, Pyright, ESLint, tsc, imports, comments)", after the commit hook step and the new `npm ci` step ("Install dependencies", moved out of `local-gate.json` so tsc can resolve the product's imports) and before the audit and every test. `.githooks/pre-commit` runs `.security/lint.py staged` on the staged text with Ruff, Pyright, ESLint and the import, suppression and comment checks (tsc needs the whole tree, so it runs in the gate only). On the Mac mini the gate step takes 3.8 to 5.3 seconds over today's tree, and the hook about 2.3 seconds for a commit staging a few files. `local-gate.py` sets `LOCAL_GATE_BASE` to the merge base with `origin/main`, and `scan.py` audits the lint tools' dependencies at the high threshold.

The tools install into `~/.local/share/repo-lint/apple-tools-mcp/` and are found there, never on `PATH`, so no shared `~/.local/bin` link is touched. Install or update them with `bash .cursor/install-lint.sh` (`install-security.sh` runs it). Run `npm ci` once at the repository root first, so tsc can read the product's packages.

## The ratchet

Each finding is keyed by its tool, rule, file and a hash of its line's text, so moving code does not change it. `.lint/baseline.json` holds today's findings:

| Tool | Findings held |
|---|---|
| Ruff | 0 |
| Pyright | 0 |
| ESLint | 141 (140 unused names, 1 declaration in a `case`) |
| tsc | 0 |
| Imports | 0 |
| Suppression | 0 |
| Comments | 0 (6,504 lines in 177 files before the 17 cleanup parts) |

The list only shrinks:

- A change fails on a finding absent from both the baseline and the PR base, including indirect breakage in untouched files. Editing a finding's line changes its key. A renamed file keeps its old findings.
- A finding already on the PR base is a warning even in a touched file, so a merge commit is not blamed for main's finding. Counts matter: one existing occurrence does not excuse a second new one.
- A baseline that gains an entry fails. The one way in is a new check's first entries (`python3 .security/lint.py baseline` writes them only for a tool the baseline's `tools` list does not hold yet). When code is fixed, the gate warns that entries are stale; `python3 .security/lint.py prune` drops them and never adds one (`prune --resolved-only` leaves every kept entry's line field as it was).
- With no PR base (the deploy gate), findings outside the baseline are warnings.

`python3 .security/lint.py counts` prints the findings per tool. `python3 .security/lint.py comments` lists every comment line the ban flags.

## The comment ban

Comments go stale, and agents copy them and lean on them; the fix for code that needs explaining is a better name or a test (Lauren Tan: comments "go stale easily"; the lint rule comes first, so no new comment lands, then the old ones are cleaned).

**What fails.** Each line of a new comment is one finding, `comments no-comment`: `#` in Python and shell, `//` and `/* */` in JavaScript, on its own line or after code. Editing a line that holds an old comment makes it new, so remove the comment while you are there. A Python docstring nothing reads is `comments no-docstring`, per line.

**How it reads code, so text is never a false alarm.** JavaScript through TypeScript's scanner (strings, template strings and regular expressions are never comments; checked against espree, the parser ESLint uses, which finds the same comments on today's tree apart from the line 1 shebang), Python through `tokenize` and `ast`, shell through shfmt's parser. Only `.js`, `.mjs`, `.cjs`, `.py`, `.sh` and `.bash` files are read, plus files with no suffix whose first line is a python, sh, bash, dash or ksh shebang. Data and text files are never read. A file the reader cannot parse fails as `comments unreadable-javascript` or `unreadable-shell`, so no comment slips through unread (none today).

**Allowed.**
- A shebang on line 1.
- A comment line holding a link to an upstream issue, pull request, bug or RFC (GitHub, GitLab and Codeberg issues, pulls, merge requests and discussions except Peter's own `sfls1397` repositories; bugzilla and `bugs.` hosts; crbug and the Chromium and Google trackers; rfc-editor.org and the IETF datatracker).
- License text: the file's leading comment block, when a line holds `SPDX-License-Identifier:`, `Copyright`, `Licensed under`, `Permission is hereby granted` or `All rights reserved`.
- Comments a tool needs to work: Python's encoding line on line 1 or 2, and ShellCheck's `shell=`, `source=` and `source-path=` directives. `# shellcheck disable=`, `# noqa` and `eslint-disable` turn a checker off rather than help it work, so they are not allowed.

**Docstrings count, unless the program reads them** (the module docstring of a file that reads `__doc__`, or a function or class docstring read as `name.__doc__`).

## Rules dropped, and why

False alarms must be zero, so a check that flags correct code is tuned or dropped (Peter: false alarms must be zero, quality first, cost second, time third; about 7:50 PM CT Nov 15 2026). Each tool was first run with its widest rule set over the whole repo and every rule's hits were read. The kept set is the Toolbox's, re-read against this repo.

**Ruff** (3,034 findings across 49 rules with every rule on): style families dropped because they flag correct code: quotes (1,687), line length (334), annotations (363), docstrings, `print`, pathlib, `%` formatting (70), pytest style on unittest tests, exception message style, `subprocess` argument style (`PLW1510`, `S603`, `S607`; Semgrep owns security), magic numbers, argument counts, complexity. The Toolbox's bug rule drops apply for the same reasons (`B904`, `RUF005`, `PLW2901`, `RUF059`, `E731`, `ARG001`, `ARG005`). The kept set finds 0 today.

**Pyright** (31 errors in standard mode, 1,335 in strict): the code has no annotations, so strict is all "unknown" noise. Off in standard, as in the Toolbox: `reportArgumentType`, `reportOptionalMemberAccess`, `reportOptionalSubscript`, `reportOptionalOperand`, `reportOptionalIterable`, `reportOptionalCall`, `reportOptionalContextManager`, `reportPossiblyUnboundVariable`, `reportIndexIssue`, `reportOperatorIssue` (a mixed dict literal reads as a union, and a `spec.loader` or `re.match` result is checked by the code's own flow), `reportMissingImports`, `reportMissingModuleSource`, the override rules, `reportUnusedExpression` and `reportInvalidStringEscapeSequence` (Ruff's `W605` owns it). Kept in part: `reportAttributeAccessIssue` for module attributes, `reportCallIssue` for wrong argument counts and names, `reportGeneralTypeIssues` for features that need Python 3.10. The kept set finds 0 today.

**ESLint** (141 findings kept; 205 more of the dropped problem rules in the widest run, which turned on every problem rule). Dropped after reading their hits: `no-await-in-loop` (322, deliberate sequencing), `no-use-before-define` (71, function hoisting), `no-promise-executor-return` (71, `new Promise(r => setTimeout(r, n))`), `require-atomic-updates` (37), `no-useless-assignment` (20), `no-control-regex` (10, the code matches control characters on purpose), `no-template-curly-in-string` (9, tests assert on source text that holds `${`), `no-unsafe-finally` (2, a caught throw inside a `finally`), `no-prototype-builtins` (1), `no-unmodified-loop-condition` (1, a loop that waits on an async change). Tuned for tests only: `afterAll`, `describe`, `it`, `test`, `expect`, `vi`, `beforeAll`, `beforeEach` and `afterEach` are globals there (12 `no-undef` hits were `afterAll` in the perf tests, which `vitest.config.js` makes global with `globals: true`), and `no-script-url` is off because a security test hands `'javascript:alert(1)'` to a URL validator on purpose. Kept and read: `no-unused-vars` (140 real unused imports, names and assigned values; arguments, caught errors, rest siblings, names starting `_` and JXA's `run` are not counted) and `no-case-declarations` (1, `index.js`: a `const` in a bare `case`, correct today, a trap for the next edit).

**tsc** (strict, `--checkJs`): strict reports implicit `any`, object-literal property errors, arity and `null` errors on correct JavaScript, so only exact codes count, as in the Toolbox: undefined names (`TS2304`, `TS2552`, `TS2580`, `TS2591`, `TS2592`), duplicate declarations, unresolved imports and missing exports (`TS2307`, `TS2305`, `TS2306`, `TS2613`, `TS2614`, `TS2724`, `TS2459`, `TS2460`), grammar errors below `TS1200`, and a property missing on a Node module (`typeof import(...)`). Two grammar codes are dropped because they come from JSDoc, not code: `TS1003` (a doc comment in `lib/mailWrite.js` once contained `@2.1.1`, which TypeScript reads as a tag, and Node and ESLint accepted the file; the comment is gone and the exemption stays harmless) and `TS1064` (a JSDoc `@returns` on an async function in `tests/indexing/helpers/performance-utils.js`, since removed with the file's comments; the exemption stays harmless; ESLint's parser still reports every real syntax error). Vitest's globals (`describe`, `afterAll` and the rest) are declared for every file in `.lint/vitest-globals.d.ts`, since the config makes them global (12 `TS2304` hits were `afterAll`).

## Changing a pin or a rule

Config changes are conservatively reviewed. A change to the lint configs, kept tsc codes or Pyright filters needs an exact `.lint/policy-review.json` with `before`, `after` and a specific `reason` of at least 40 characters. Obtain the fingerprints with `.security/lint.py`'s `policy_digest(base)` and `policy_digest()` functions. A missing, stale or symlinked note fails the gate. The baseline-growth prohibition is unchanged.

Edit `.lint/package.json` and regenerate the lockfile, or the Ruff version and checksums in `.cursor/install-lint.sh`, run the installer, then `python3 .security/lint.py counts`. A pin or rule that finds new findings in today's code needs those fixed in the same PR, since the baseline never grows.

## Comments in today's code, and the cleanup parts

The cleanup is complete: all 17 parts merged and the comment count is 0, with no comment entry left in the baseline. The measurements below are from before it, on main at 84cebd2 with this check: 6,504 comment lines in 177 files (`tests` 3,156, `lib` 2,258, repository root 855, `scripts` 143, `.security` 63, `bin` 20, `.cursor` 5, `.githooks` 4). Two lines name Peter (`tests/unit/http-auth.test.js:104`, `tests/unit/write-tools.test.js:1799`); no lesson ID sits in a comment; about 28 name a PR or a date. Each of those reasons must live where it belongs before its comment is deleted.

The most: `indexer.js` 361, `lib/mailWrite.js` 286, `lib/validators.js` 198, `search.js` 193, `lib/audit.js` 186, `index.js` 183, `lib/appleScript.js` 169.

One job per part, in this order, on a mid tier model (Peter: it does not need a high model; about 8:45 PM CT Nov 15 2026). A part starts after the one before merges.

| Part | Files | Lines |
|---|---|---|
| 1 | `.cursor`, `.githooks`, `.security`, `bin`, `scripts`, `contacts.js` | 353 |
| 2 | `index.js` | 183 |
| 3 | `indexer.js` | 361 |
| 4 | `search.js` to `lib/appleScript.js` | 362 |
| 5 | `lib/audit.js` to `lib/contactsWrite.js` | 439 |
| 6 | `lib/eventKitSession.js` to `lib/keychainWrite.js` | 410 |
| 7 | `lib/lancedbTables.js` to `lib/mailWrite.js` | 435 |
| 8 | `lib/messageContact.js` to `lib/urlQuery.js` | 390 |
| 9 | `lib/validators.js` to `lib/writeTools.js` | 415 |
| 10 | `tests/chaos/fault-injection.test.js` to `tests/indexing/contacts/contact-resolution.test.js` | 448 |
| 11 | `tests/indexing/contacts/real-contacts.test.js` to `tests/indexing/integration/incremental-indexing.test.js` | 442 |
| 12 | `tests/indexing/integration/initial-indexing.test.js` to `tests/indexing/performance/throughput.test.js` | 418 |
| 13 | `tests/indexing/resource/concurrent-access.test.js` to `tests/indexing/unit/metadata-handling.test.js` | 438 |
| 14 | `tests/indexing/unit/orchestration.test.js` to `tests/perf/helpers/benchmark.js` | 429 |
| 15 | `tests/perf/helpers/data-generators.js` to `tests/recovery/resilience.test.js` | 448 |
| 16 | `tests/snapshots/results.test.js` to `tests/unit/url-query.test.js` | 430 |
| 17 | `tests/unit/validators.test.js` to `tests/unit/write-tools.test.js` | 103 |

Where each kind's "why" goes: a Peter citation goes to the rule or doc that owns the behavior, or in the name of the test that guards it; a history comment (a PR, a date, an incident) is already in Git, and a guard it explains gets a test named for the failure it prevents; narration goes nowhere, and unclear code gets a better name; a docstring is treated as narration, unless the program reads it; a divider goes nowhere.

Each part's job (`.security/comment_tool.py` lists, strips and compares; the reasons that stay live in `docs/code-notes.md`, the guarding test's name, or the doc that owns the behavior): search tests and readers for the part's file names (`readFileSync` and equivalents) and for comment text a test anchors on; list the Peter citations; move each why, then delete the comments with no behavior change (a rename is the only code change); run `python3 .security/lint.py prune --resolved-only` and `counts`; prove no behavior changed with identical syntax trees for every changed file (JavaScript with espree or the TypeScript compiler ignoring comments and positions, Python with `ast.dump`, shell with `shfmt -mn`) plus the recorded gate; list each moved citation in the PR. A deleted comment can already be stale, so check every claim, number and guard test name against the code before it moves into `docs/code-notes.md`. `strip` prints a warning when findings sit outside the baseline afterwards: a held lint finding on a line with a trailing comment is keyed by that line's text, so stripping the comment re-keys it and the gate fails with "the baseline grew"; delete the dead variable, or rename it with a leading underscore if the read matters, and never re-key the baseline by hand.
