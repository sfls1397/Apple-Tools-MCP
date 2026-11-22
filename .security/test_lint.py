#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SETUP = ['.security/lint.py', '.security/comment_tool.py', '.security/script-tree.mjs', '.cursor/install-lint.sh', '.lint/ruff.toml', '.lint/eslint.config.mjs', '.lint/tsconfig.json',
         '.lint/vitest-globals.d.ts', '.lint/reader.mjs', '.lint/package.json', '.lint/package-lock.json', 'pyrightconfig.json', 'package.json']
FILES = {
    'lib/add.js': 'export function add(a, b) {\n  return a + b;\n}\n',
    'lib/legacy.js': 'const unused = 1;\n// an old note\nexport const kept = 1;\n',
    'lib/held.js': 'const dead = 1; // a trailing note\nexport const alive = 1;\n',
    'tests/helper.js': 'export const helper = 1;\n',
    'scripts/old.js': 'export const value = 1;\n',
    '.security/old.py': 'import os\n\n\ndef ok():\n    return 1\n',
    '.githooks/old': '#!/bin/sh\n# an old shell note\necho ok\n',
}
NEW_TYPE_ERROR = {'lib/new.js': "import { nope } from 'node:fs';\nexport const wrong = nope;\n"}
NEW_LINT = {'scripts/dup.js': 'export const settings = { mode: 1, mode: 2 };\n'}
NEW_COMMENT_JS = {'lib/commented.js': 'export const x = 1; // says what the code does\n'}
NEW_COMMENT_PY = {'.security/commented.py': 'VALUE = 1  # says what the code does\n'}
NEW_COMMENT_SH = {'.githooks/commented': '#!/bin/sh\n# says what the code does\necho ok\n'}


def load_gate():
    spec = importlib.util.spec_from_file_location('gate_steps', HERE / 'local-gate.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LintStep(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='lint-probe-')
        self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        for name in SETUP:
            self.write({name: (ROOT / name).read_text()})
        self.write({'.gitignore': 'node_modules/\n'})
        (self.dir / 'node_modules').symlink_to(ROOT / 'node_modules')
        self.write(FILES)
        self.commit('base')
        made = self.lint('baseline')
        self.assertEqual(made.returncode, 0, made.stdout + made.stderr)
        self.base = self.commit('baseline')

    def git(self, *args):
        result = subprocess.run(['git', '-c', 'user.email=probe@users.noreply.github.com', '-c', 'user.name=Probe',
                                 '-c', 'commit.gpgsign=false'] + list(args), cwd=self.dir, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, 'git %s: %s' % (' '.join(args), result.stderr))
        return result.stdout.strip()

    def write(self, files):
        for name, text in files.items():
            path = self.dir / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if text is None:
                path.unlink()
            else:
                path.write_text(text)
                if text.startswith('#!'):
                    path.chmod(0o755)

    def commit(self, message, files=None):
        self.write(files or {})
        self.git('add', '-A')
        self.git('commit', '-q', '--no-verify', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def lint(self, mode, base=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith('LOCAL_GATE_')}
        if base:
            env['LOCAL_GATE_BASE'] = base
        return subprocess.run([sys.executable, '.security/lint.py', mode], cwd=self.dir, env=env, capture_output=True, text=True)

    def comment_tool(self, *args):
        return subprocess.run([sys.executable, '.security/comment_tool.py'] + list(args), cwd=self.dir, capture_output=True, text=True)

    def blocked(self, files, expect):
        self.commit('change', files)
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('Types and lint BLOCKED', result.stdout)
        for text in expect:
            self.assertIn(text, result.stdout)
        return result.stdout

    def test_the_gate_runs_the_lint_step_after_dependencies_and_before_audit_and_tests(self):
        gate = load_gate()
        names = [name for name, _ in gate.STANDARD]
        lint = next(i for i, name in enumerate(names) if name.startswith('Types and strict lint'))
        self.assertEqual(dict(gate.STANDARD)[names[lint]], ['python3', '.security/lint.py', 'gate'])
        self.assertLess(names.index('Pre-commit hook'), lint)
        self.assertLess(names.index('Install dependencies'), lint)
        self.assertLess(lint, names.index('npm audit (production, high) + offline Semgrep + ShellCheck/Clang'))
        self.assertLess(lint, names.index('Gate enforcement probes'))
        self.assertNotIn(['npm', 'ci'], json.loads((ROOT / '.security/local-gate.json').read_text())['tests'])
        for tool in ['ruff', 'shfmt', 'eslint', 'typescript', 'pyright']:
            self.assertIn(tool, gate.PINS)
        self.assertIn('python3 .security/lint.py staged', (ROOT / '.githooks/pre-commit').read_text())

    def test_today_s_code_passes_and_the_pass_line_counts_what_the_baseline_holds(self):
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r'Types and lint PASS: .* findings held by the baseline, none new')
        held = json.loads((self.dir / '.lint/baseline.json').read_text())['findings']
        self.assertTrue(any(item['tool'] == 'eslint' for item in held))
        self.assertTrue(any(item['tool'] == 'ruff' for item in held))
        self.assertTrue(any(item['tool'] == 'comments' for item in held))

    def test_a_new_type_error_fails_the_gate(self):
        self.blocked(NEW_TYPE_ERROR, ['tsc TS2305 lib/new.js:1'])

    def test_a_new_lint_finding_fails_the_gate(self):
        self.blocked(NEW_LINT, ['eslint no-dupe-keys scripts/dup.js:1'])

    def test_a_new_python_error_in_a_dot_folder_is_read_and_fails(self):
        self.blocked({'.security/broken.py': 'import os\nos.nope(1)\nprint(missing_name)\n'},
                     ['pyright reportAttributeAccessIssue:module .security/broken.py:2', 'ruff F821 .security/broken.py:3'])

    def test_a_new_comment_fails_the_gate_in_javascript_python_and_shell(self):
        out = self.blocked({**NEW_COMMENT_JS, **NEW_COMMENT_PY, **NEW_COMMENT_SH},
                           ['comments no-comment lib/commented.js:1', 'comments no-comment .security/commented.py:1',
                            'comments no-comment .githooks/commented:2'])
        self.assertNotIn('legacy.js', out)

    def test_a_new_docstring_nothing_reads_fails_the_gate(self):
        self.blocked({'.security/doc.py': 'def f():\n    """Explains f."""\n    return 1\n'}, ['comments no-docstring .security/doc.py:2'])

    def test_a_turned_off_checker_fails_the_gate(self):
        self.blocked({'lib/off.js': '// @ts-ignore\nexport const bad = 1;\n'}, ['suppress inline-suppression lib/off.js:1'])

    def test_an_import_of_a_test_file_from_product_code_fails_but_a_test_may_import_it(self):
        self.blocked({'lib/uses.js': "import { helper } from '../tests/helper.js';\nexport const v = helper;\n"},
                     ['imports no-test-or-fixture-import lib/uses.js:1'])

    def test_moving_a_baselined_finding_and_its_comment_stays_green(self):
        self.commit('move', {'lib/legacy.js': '\n\nconst unused = 1;\n// an old note\nexport const kept = 1;\n',
                             '.githooks/old': '#!/bin/sh\n\n# an old shell note\necho ok\n'})
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_editing_a_baselined_comment_makes_it_new(self):
        self.blocked({'lib/legacy.js': 'const unused = 1;\n// an old note, reworded\nexport const kept = 1;\n'},
                     ['comments no-comment lib/legacy.js:2'])

    def test_text_that_only_looks_like_a_comment_is_never_a_finding(self):
        text = ('export const url = "http://example.com//path";\nexport const pattern = /a\\/\\/b|\\/\\*x/;\n'
                'export const note = `// inside a template ${url} /* not a comment */`;\nexport const hash = "#!/bin/sh";\n')
        self.commit('strings', {'lib/strings.js': text, '.security/strings.py': 'TEXT = "# not a comment"\nOTHER = """\n# inside\n"""\n'})
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_allowed_comments_pass(self):
        files = {
            'lib/license.js': '/* SPDX-License-Identifier: MIT */\nexport const l = 1;\n',
            'lib/upstream.js': '// https://github.com/microsoft/TypeScript/issues/12345\nexport const u = 1;\n',
            'bin/tool.js': '#!/usr/bin/env node\nexport const run = 1;\n',
            'bin/tool': '#!/usr/bin/env python3\nprint(1)\n',
        }
        self.commit('allowed', files)
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_strip_cuts_a_trailing_comment_at_the_right_column_after_wide_characters(self):
        files = {'lib/wide.js': 'export const a = "\U0001F600 x"; // says what it does\nexport const b = "\u00e9"; /* note */ export const c = 1; // tail\n',
                 '.githooks/wide': '#!/bin/sh\necho "\U0001F600\u00e9" # says what it does\necho ok\n'}
        self.commit('wide', files)
        result = self.comment_tool('strip', 'lib/wide.js', '.githooks/wide')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.dir / 'lib/wide.js').read_text(), 'export const a = "\U0001F600 x";\nexport const b = "\u00e9"; export const c = 1;\n')
        self.assertEqual((self.dir / '.githooks/wide').read_text(), '#!/bin/sh\necho "\U0001F600\u00e9"\necho ok\n')
        same = self.comment_tool('same-tree', '--base', 'HEAD', 'lib/wide.js', '.githooks/wide')
        self.assertEqual(same.returncode, 0, same.stdout + same.stderr)
        self.assertIn('same lib/wide.js', same.stdout)
        self.assertIn('same .githooks/wide', same.stdout)

    def test_strip_warns_when_a_held_finding_sat_on_a_line_with_a_trailing_comment(self):
        result = self.comment_tool('strip', 'lib/held.js')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.dir / 'lib/held.js').read_text(), 'const dead = 1;\nexport const alive = 1;\n')
        self.assertIn('WARNING: 1 lint findings are now outside the baseline', result.stdout)

    def test_strip_stays_quiet_when_nothing_held_loses_its_comment(self):
        self.commit('note', {'lib/clean.js': 'export const fine = 1; // says what it does\n'})
        result = self.comment_tool('strip', 'lib/clean.js')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('WARNING', result.stdout)

    def test_same_tree_says_a_list_in_one_argument_is_one_file_name(self):
        result = self.comment_tool('same-tree', '--base', 'HEAD', 'lib/add.js lib/legacy.js')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('give each file as its own argument', result.stdout)
        ok = self.comment_tool('same-tree', '--base', 'HEAD', 'lib/add.js', 'lib/legacy.js')
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)

    def test_the_baseline_cannot_grow(self):
        path = self.dir / '.lint/baseline.json'
        data = json.loads(path.read_text())
        first = dict(data['findings'][0])
        first['count'] += 1
        data['findings'][0] = first
        self.commit('grow', {'.lint/baseline.json': json.dumps(data, indent=1) + '\n'})
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('the baseline grew', result.stdout)

    def test_a_file_that_cannot_be_read_is_a_finding_not_a_silent_pass(self):
        self.blocked({'lib/broken.js': 'export const = ;\n'}, ['comments unreadable-javascript lib/broken.js'])

    def test_the_commit_hook_blocks_a_staged_new_comment_and_passes_a_staged_baselined_line(self):
        self.write({'lib/legacy.js': '\nconst unused = 1;\n// an old note\nexport const kept = 1;\n'})
        self.git('add', '-A')
        passing = self.lint('staged')
        self.assertEqual(passing.returncode, 0, passing.stdout + passing.stderr)
        self.write(NEW_COMMENT_JS)
        self.git('add', '-A')
        failing = self.lint('staged')
        self.assertEqual(failing.returncode, 1, failing.stdout + failing.stderr)
        self.assertIn('comments no-comment lib/commented.js:1', failing.stdout)

    def test_the_commit_hook_blocks_a_staged_new_lint_finding(self):
        self.write(NEW_LINT)
        self.git('add', '-A')
        failing = self.lint('staged')
        self.assertEqual(failing.returncode, 1, failing.stdout + failing.stderr)
        self.assertIn('eslint no-dupe-keys scripts/dup.js:1', failing.stdout)

    def test_a_config_change_needs_a_review_note(self):
        self.blocked({'.lint/ruff.toml': (ROOT / '.lint/ruff.toml').read_text() + '\n# widened\n'}, ['lint-policy-review'])

    def test_a_tool_that_reads_nothing_is_an_error_not_a_pass(self):
        shutil.rmtree(self.dir / 'node_modules', ignore_errors=True)
        (self.dir / 'node_modules').unlink(missing_ok=True)
        result = self.lint('gate', self.base)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('npm ci', result.stdout)


if __name__ == '__main__':
    unittest.main()
