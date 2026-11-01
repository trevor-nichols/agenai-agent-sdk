import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function concurrencySourceClosure(root) {
  const { default: ts } = await import('typescript');
  const sourceRoot = await realpath(root);
  const pending = [resolve(sourceRoot, 'platform/capabilities/concurrency/controller.mjs')];
  const result = new Set();
  while (pending.length) {
    const path = pending.pop(); const local = relative(sourceRoot, path);
    assert(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && path.endsWith('.mjs'),
      'Bounded qualification source closure required.');
    const name = local.split(sep).join('/'); if (result.has(name)) continue;
    assert(result.size < 128, 'Bounded qualification source closure required.');
    assert.equal(await realpath(path), path, 'Bounded qualification source closure requires physical files.');
    result.add(name);
    const bytes = await readFile(path); assert(bytes.length <= 1024 ** 2);
    const source = ts.createSourceFile(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0, 'Qualification source closure requires valid JavaScript.');
    const enqueue = (specifier) => {
      const target = new URL(specifier, pathToFileURL(path));
      assert(target.protocol === 'file:' && target.search === '' && target.hash === '', 'Bounded qualification source closure required.');
      pending.push(fileURLToPath(target));
    };
    const module = (specifier) => {
      if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) enqueue(specifier);
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert(ts.isStringLiteralLike(node.moduleSpecifier)); module(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteralLike(node.arguments[0])) module(node.arguments[0].text);
      else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
        && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0])) {
        const base = node.arguments[1];
        if (ts.isPropertyAccessExpression(base) && base.name.text === 'url' && ts.isMetaProperty(base.expression)
          && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword && base.expression.name.text === 'meta'
          && new URL(node.arguments[0].text, pathToFileURL(path)).pathname.endsWith('.mjs')) enqueue(node.arguments[0].text);
      }
      // Syntax nodes retain embedded guest source as string bytes, without treating it as host ESM.
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return Object.freeze([...result].sort());
}
