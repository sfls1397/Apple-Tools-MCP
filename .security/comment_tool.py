#!/usr/bin/env python3
"""List, strip and check the comments of a cleanup part (docs/TYPES-AND-LINT.md, The cleanup plan).

  python3 .security/comment_tool.py list [--json] FILE...       every comment line the ban flags, with its kind and where a lesson ID already lives
  python3 .security/comment_tool.py strip FILE...               remove those comment lines, exactly the ones lint.py flags; nothing else changes
  python3 .security/comment_tool.py same-tree [--base REF] [--blank-test-titles] FILE...
                                                                 each file's syntax tree against the same file at REF (default origin/main): ast for
                                                                 Python, TypeScript compiler tokens for JavaScript, shfmt -mn for shell; a docstring or comment is no part of it

Run from the repository root. Exit 1 when same-tree finds a file that differs or cannot be read."""
import ast
import collections
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tokenize

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('lint', HERE / 'lint.py')
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)
KINDS = (('peter citation', re.compile(r'\bPeter\b')), ('lesson reason', re.compile(r'\bL-[0-9a-f]{10}\b')),
         ('history', re.compile(r'\bPRs?\s*#?\d+|\bpull\s+#?\d+|\b20\d\d-\d\d-\d\d\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b|\bincident\b', re.I)),
         ('tool suppression', re.compile(r'noqa|shellcheck\s+disable|eslint-disable|pyright:|type:\s*ignore')), ('divider', re.compile(r'^[\W_]*$')))
LESSON = re.compile(r'\bL-[0-9a-f]{10}\b')


def utf16_index(line, column):
    units = 0
    for index, character in enumerate(line):
        if units >= column:
            return index
        units += 2 if ord(character) > 0xFFFF else 1
    return len(line)


def byte_index(line, column):
    return len(line.encode()[:column].decode(errors='ignore'))


def file_lines(root, name):
    return (Path(root) / name).read_text().split('\n')


def in_characters(spans, lines, convert):
    return [(start, convert(lines[start - 1], first) if start <= len(lines) else first, end, convert(lines[end - 1], last) if end <= len(lines) else last)
            for start, first, end, last in spans]


def shell_in_characters(spans, lines):
    converted = []
    for start, first, end, last in spans:
        begin = byte_index(lines[start - 1], first) if start <= len(lines) else first
        converted.append((start, begin, end, begin + (last - first) if end == start else last))
    return converted


def spans_of(root, source, python, script, shell):
    spans = collections.defaultdict(list)
    for name in python:
        spans[name] = [(token.start[0], token.start[1], token.end[0], token.end[1]) for token in lint.python_tokens(source, name)
                       if token.type == tokenize.COMMENT and not lint.PY_SUPPRESS.search(token.string)]
    if script:
        for item in source.script_reads(script)['comments']:
            spans[lint.relative(root, item['file'])].append((item['line'], item['column'], item['endLine'], item['endColumn']))
        for name in script:
            spans[name] = in_characters(spans[name], file_lines(root, name), utf16_index)
    for name in shell:
        spans[name] = shell_in_characters(lint.shell_spans(root, '\n'.join(source.lines(name)) + '\n') or [], file_lines(root, name))
    return spans


def kind_of(text, rule):
    if rule == 'no-docstring':
        return 'docstring'
    for kind, pattern in KINDS:
        if pattern.search(text.strip()):
            return kind
    return 'narration'


def parts(root, names):
    python, script, shell = lint.kinds(root, names)
    source = lint.Source(root)
    return python, script, shell, source


def flagged(root, names):
    python, script, shell, source = parts(root, names)
    return lint.check_comments(root, python, script, shell, source), source, (python, script, shell)


def listing(root, names):
    found, source, _ = flagged(root, names)
    rows = []
    for item in sorted(found, key=lambda item: (item['file'], item['line'])):
        text = source.line(item['file'], item['line'])
        rows.append(dict(file=item['file'], line=item['line'], kind=kind_of(text, item['rule']), rule=item['rule'], text=text.strip()))
    listed = {(row['file'], row['line']) for row in rows}
    where = {}
    for lesson in sorted({match for row in rows for match in LESSON.findall(row['text'])}):
        result = subprocess.run(['git', 'grep', '-n', '-e', lesson], cwd=str(root), capture_output=True, text=True)
        hits = (row.split(':', 2) for row in result.stdout.splitlines())
        where[lesson] = sorted({path for path, number, _ in hits if (path, int(number)) not in listed})
    return rows, where


def listing_report(rows, where, as_json):
    if as_json:
        return json.dumps(dict(comments=rows, lesson_ids=where), indent=1)
    lines = [f"{row['file']}:{row['line']} {row['kind']}: {row['text']}" for row in rows]
    counts = collections.Counter(row['kind'] for row in rows)
    lines.append('total %d: %s' % (len(rows), ', '.join(f'{kind} {count}' for kind, count in sorted(counts.items())) or 'none'))
    for lesson, files in where.items():
        lines.append(f'{lesson} appears in: {", ".join(files)}')
    return '\n'.join(lines)


def docstring_spans(name, text, flagged_lines):
    spans = []
    for node in ast.walk(ast.parse(text, filename=name)):
        for field in ('body', 'orelse', 'finalbody'):
            body = getattr(node, field, None)
            if isinstance(body, list):
                spans += [(item.lineno, item.end_lineno, len(body) == 1) for item in body
                          if isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str) and item.lineno in flagged_lines]
    return spans


def strip_text(text, spans, flagged_lines, docstrings):
    lines = text.split('\n')
    cuts = collections.defaultdict(list)
    for start, first, end, last in spans:
        if any(number in flagged_lines for number in range(start, end + 1)):
            for number in range(start, end + 1):
                cuts[number].append((first if number == start else 0, last if number == end else len(lines[number - 1])))
    drop, edit = set(), {}
    for number, items in cuts.items():
        line = lines[number - 1]
        for begin, stop in sorted(items, reverse=True):
            joined = line[:begin] + line[stop:]
            if (not line[:begin] or line[:begin].endswith(' ')) and line[stop:].startswith(' '):
                joined = line[:begin] + line[stop:].lstrip(' ')
            line = joined
        if line.strip():
            edit[number] = line.rstrip()
        else:
            drop.add(number)
    for start, end, only in docstrings:
        if only:
            edit[start] = re.match(r'\s*', lines[start - 1]).group() + 'pass'
            drop.update(range(start + 1, end + 1))
        else:
            drop.update(range(start, end + 1))
    return '\n'.join(edit.get(number, line) for number, line in enumerate(lines, 1) if number not in drop)


def strip(root, names):
    found, source, (python, script, shell) = flagged(root, names)
    unreadable = sorted({item['file'] for item in found if item['rule'].startswith('unreadable')})
    if unreadable:
        raise lint.LintError('cannot read ' + ', '.join(unreadable))
    spans = spans_of(root, source, python, script, shell)
    comments, docstrings = collections.defaultdict(set), collections.defaultdict(set)
    for item in found:
        (docstrings if item['rule'] == 'no-docstring' else comments)[item['file']].add(item['line'])
    changed = {}
    for name in sorted(set(comments) | set(docstrings)):
        path = Path(root) / name
        before = path.read_text()
        after = strip_text(before, spans.get(name, []), comments[name], docstring_spans(name, before, docstrings[name]) if docstrings[name] else [])
        if after != before:
            path.write_text(after)
            changed[name] = len(comments[name]) + len(docstrings[name])
    return changed


def python_tree(text):
    tree = ast.parse(text)
    for node in ast.walk(tree):
        for field in ('body', 'orelse', 'finalbody'):
            body = getattr(node, field, None)
            if isinstance(body, list):
                body[:] = [item for item in body if not (isinstance(item, ast.Expr) and isinstance(item.value, ast.Constant) and isinstance(item.value.value, str))]
                if not body and field == 'body' and not isinstance(node, ast.Module):
                    body.append(ast.Pass())
    return ast.dump(tree)


def trees(root, name, texts, blank):
    python, script, shell = lint.kinds(root, [name])
    if python:
        return [python_tree(text) for text in texts]
    with tempfile.TemporaryDirectory(prefix='comment-tool-') as folder:
        if script:
            suffix = Path(name).suffix
            paths = []
            for index, text in enumerate(texts):
                paths.append(Path(folder) / f'{index}{suffix}')
                paths[-1].write_text(text)
            result = lint.run(['node', str(HERE / 'script-tree.mjs'), str(lint.node_root() / 'node_modules'), 'yes' if blank else 'no'] + [str(item) for item in paths], root)
            data = json.loads(result.stdout)
            return [json.dumps(data[str(item)], sort_keys=True) if data[str(item)] else None for item in paths]
        if shell:
            outputs = []
            for text in texts:
                result = subprocess.run([lint.tool('shfmt'), '-ln', 'bash', '-mn'], input=text, capture_output=True, text=True)
                outputs.append(result.stdout if result.returncode == 0 else None)
            return outputs
    return [None, None]


def outside_baseline(root):
    result = subprocess.run([sys.executable, str(HERE / 'lint.py'), 'counts'], cwd=str(root), capture_output=True, text=True)
    match = re.search(r'(\d+) outside the baseline', result.stdout)
    return int(match.group(1)) if match else 0


def same_tree(root, base, names, blank):
    different = 0
    for name in names:
        shown = subprocess.run(['git', 'show', f'{base}:{name}'], cwd=str(root), capture_output=True, text=True)
        if shown.returncode:
            hint = '; give each file as its own argument, a quoted list is one name' if re.search(r'\s', name) else ''
            print(f'UNREADABLE {name}: not in {base}{hint}')
            different += 1
            continue
        try:
            before, after = trees(root, name, [shown.stdout, (Path(root) / name).read_text()], blank)
        except (SyntaxError, ValueError, OSError, lint.LintError) as error:
            print(f'UNREADABLE {name}: {error}')
            different += 1
            continue
        if before is None or after is None:
            print(f'UNREADABLE {name}: the tree could not be read')
            different += 1
        elif before != after:
            print(f'DIFFERENT {name}')
            different += 1
        else:
            print(f'same {name}')
    return 1 if different else 0


def main(argv):
    command, args = (argv[0], argv[1:]) if argv else ('', [])
    root = Path.cwd()
    if command == 'list':
        as_json = '--json' in args
        rows, where = listing(root, [item for item in args if item != '--json'])
        print(listing_report(rows, where, as_json))
        return 0
    if command == 'strip' and args:
        changed = strip(root, args)
        for name, count in sorted(changed.items()):
            print(f'stripped {count} comment lines from {name}')
        print(f'{sum(changed.values())} comment lines removed from {len(changed)} files')
        held = outside_baseline(root) if changed else 0
        if held:
            print(f'WARNING: {held} lint findings are now outside the baseline. A held finding sat on a line with a trailing comment, and stripping it changed the finding key. '
                  'Delete the dead variable, or rename it with a leading underscore if the read matters; do not re-key the baseline.')
        return 0
    if command == 'same-tree':
        base = 'origin/main'
        blank = '--blank-test-titles' in args
        rest = [item for item in args if item != '--blank-test-titles']
        if '--base' in rest:
            index = rest.index('--base')
            base = rest[index + 1]
            del rest[index:index + 2]
        if rest:
            return same_tree(root, base, rest, blank)
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except lint.LintError as error:
        print(f'comment_tool: {error}', file=sys.stderr)
        sys.exit(1)
