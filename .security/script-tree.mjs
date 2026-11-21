import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [modules, blankTitles, ...files] = process.argv.slice(2);
const ts = createRequire(path.join(modules, 'script-tree.js'))('typescript');
const TESTS = new Set(['test', 'it', 'describe', 'suite']);

function rootName(callee) {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return rootName(callee.expression);
  return null;
}

function blanked(sourceFile) {
  const found = new Set();
  const walk = (node) => {
    if (ts.isCallExpression(node) && TESTS.has(rootName(node.expression)) && node.arguments.length > 0
      && (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))) found.add(node.arguments[0]);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return found;
}

function tree(node, sourceFile, titles) {
  if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return null;
  if (titles.has(node)) return ['Title'];
  const children = node.getChildren(sourceFile);
  const name = ts.SyntaxKind[node.kind];
  if (children.length === 0) return [name, node.getText(sourceFile)];
  return [name, ...children.map((child) => tree(child, sourceFile, titles)).filter((item) => item !== null)];
}

const trees = {};
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  trees[file] = sourceFile.parseDiagnostics.length > 0 ? null : tree(sourceFile, sourceFile, blankTitles === 'yes' ? blanked(sourceFile) : new Set());
}
process.stdout.write(JSON.stringify(trees));
