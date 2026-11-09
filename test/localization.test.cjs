const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const placeholders = (message) => [...message.matchAll(/\{\d+\}/g)].map(([value]) => value).sort();

test('all permission messages and interpolation values have Chinese translations', () => {
  const messages = new Set();
  for (const file of ['src/chat.ts', 'src/chatRun.ts']) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'vscode.l10n.t') {
        assert.ok(ts.isStringLiteral(node.arguments[0]), 'message must be statically extractable');
        messages.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const locale of ['', '.zh-cn', '.zh-tw']) {
    const bundle = read(`l10n/bundle.l10n${locale}.json`);
    assert.deepEqual(Object.keys(bundle).sort(), [...messages].sort());
    for (const [message, translation] of Object.entries(bundle)) {
      assert.ok(translation.trim());
      assert.deepEqual(placeholders(translation), placeholders(message), message);
    }
  }
  assert.equal(read('package.json').l10n, './l10n');
});

test('settings and command translations resolve every manifest reference', () => {
  const keys = [
    ...new Set(
      [...JSON.stringify(read('package.json')).matchAll(/%([^%]+)%/g)].map(([, key]) => key),
    ),
  ].sort();
  for (const locale of ['', '.zh-cn', '.zh-tw']) {
    const bundle = read(`package.nls${locale}.json`);
    assert.deepEqual(Object.keys(bundle).sort(), keys);
    for (const value of Object.values(bundle)) {
      assert.ok(value.trim());
    }
    assert.ok(bundle['permissions.description'].includes('Copilot Agent'));
  }
});
