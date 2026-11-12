const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('command translations resolve every manifest reference', () => {
  const keys = [
    ...new Set(
      [...JSON.stringify(read('package.json')).matchAll(/%([^%]+)%/g)].map(([, key]) => key),
    ),
  ].sort();
  assert.ok(keys.length > 0);
  for (const locale of ['', '.zh-cn', '.zh-tw']) {
    const bundle = read(`package.nls${locale}.json`);
    assert.deepEqual(Object.keys(bundle).sort(), keys);
    for (const value of Object.values(bundle)) {
      assert.ok(value.trim());
    }
  }
});

test('the manifest contributes no chat participant, settings, or runtime bundle', () => {
  // The MCP server and the skill serve every harness. A participant would work
  // only in the deprecated Local harness and would need its own approval settings.
  const manifest = read('package.json');
  assert.equal(manifest.contributes.chatParticipants, undefined);
  assert.equal(manifest.contributes.configuration, undefined);
  assert.equal(manifest.l10n, undefined);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
  assert.equal(manifest.contributes.mcpServerDefinitionProviders.length, 1);
  assert.equal(manifest.contributes.chatSkills.length, 1);
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces, { supported: true });
});
