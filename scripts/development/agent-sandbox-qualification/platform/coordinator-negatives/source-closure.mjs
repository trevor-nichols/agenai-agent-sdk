import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function coldSourceClosure(evidence, additionalEntries = []) {
  const { default: ts } = await import('typescript');
  const originalOwner = await evidence.freezeSources();
  const originalSources = new Map(originalOwner.map((item) => [item.original, item]));
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const pending = ['platform/coordinator-negatives/cold.mjs', 'platform/coordinator-negatives/cold-hook.mjs',
    'platform/coordinator/controller.mjs', ...additionalEntries].map((name) => resolve(root, name));
  const paths = new Map();
  while (pending.length) {
    const path = pending.pop(), name = relative(root, path);
    assert(name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`) && name.endsWith('.mjs'));
    if (paths.has(path)) continue;
    assert(paths.size < 128); assert.equal(await realpath(path), path);
    const bytes = await readFile(path); assert(bytes.length <= 1024 ** 2);
    const source = ts.createSourceFile(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0);
    paths.set(path, bytes);
    const enqueue = (specifier) => {
      const target = new URL(specifier, pathToFileURL(path));
      assert.equal(target.protocol, 'file:'); assert.equal(target.search, ''); assert.equal(target.hash, '');
      pending.push(fileURLToPath(target));
    };
    const module = (specifier) => { if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) enqueue(specifier); };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) module(node.moduleSpecifier.text);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) module(node.arguments[0].text);
      else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0])) {
        const base = node.arguments[1];
        if (ts.isPropertyAccessExpression(base) && base.name.text === 'url' && ts.isMetaProperty(base.expression)
          && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword && base.expression.name.text === 'meta'
          && new URL(node.arguments[0].text, pathToFileURL(path)).pathname.endsWith('.mjs')) enqueue(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const result = [...originalOwner];
  for (const [index, [original, bytes]] of [...paths].sort(([a], [b]) => a.localeCompare(b)).entries()) {
    if (!originalSources.has(original)) result.push({ original, ...await evidence.file(`sources/cold-${index}.mjs`, bytes, 1024 ** 2) });
  }
  return result;
}
