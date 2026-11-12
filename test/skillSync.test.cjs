const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SOURCE, TARGETS, render, syncSkill } = require('../scripts/sync-skill.cjs');

const targets = {
  other: {
    directory: 'plugin/skills/demo',
    replacements: [{ file: 'SKILL.md', from: 'host A or host B', to: 'host B' }],
  },
};

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdh-skill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'references'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'SKILL.md'), 'Use host A or host B.\n');
  fs.writeFileSync(path.join(sourceRoot, 'references/files.md'), 'files\n');
  fs.mkdirSync(path.join(root, 'other'));
  const targetRoot = path.join(root, 'other/plugin/skills/demo');
  return { options: { workspace: root, sourceRoot, targets }, sourceRoot, targetRoot };
}

test('sync writes the copy with host wording and check then reports no drift', (t) => {
  const { options, targetRoot } = workspace(t);
  assert.equal(syncSkill({ ...options, check: true }).length, 2);
  assert.equal(fs.existsSync(targetRoot), false, 'check must not write');
  assert.equal(syncSkill(options).length, 2);
  assert.equal(fs.readFileSync(path.join(targetRoot, 'SKILL.md'), 'utf8'), 'Use host B.\n');
  assert.equal(fs.readFileSync(path.join(targetRoot, 'references/files.md'), 'utf8'), 'files\n');
  assert.deepEqual(syncSkill({ ...options, check: true }), []);
});

test('check reports an edited copy and a file that is not in the source', (t) => {
  const { options, targetRoot } = workspace(t);
  syncSkill(options);
  fs.writeFileSync(path.join(targetRoot, 'references/files.md'), 'edited\n');
  fs.mkdirSync(path.join(targetRoot, 'extra'));
  fs.writeFileSync(path.join(targetRoot, 'extra/stale.md'), 'stale\n');
  const drift = syncSkill({ ...options, check: true });
  assert.equal(drift.length, 2);
  assert.match(drift[0], /^Out of date: .*files\.md$/);
  assert.match(drift[1], /^Not in source: .*stale\.md$/);
  syncSkill(options);
  assert.equal(fs.existsSync(path.join(targetRoot, 'extra')), false);
  assert.deepEqual(syncSkill({ ...options, check: true }), []);
});

test('a reworded source line fails the sync before anything is written', (t) => {
  const { options, sourceRoot, targetRoot } = workspace(t);
  fs.writeFileSync(path.join(sourceRoot, 'SKILL.md'), 'Use any host.\n');
  assert.throws(() => syncSkill(options), /must match exactly once, found 0/);
  assert.equal(fs.existsSync(targetRoot), false);
});

test('a missing checkout or unknown target is an error, not a silent skip', (t) => {
  const { options } = workspace(t);
  fs.rmSync(path.join(options.workspace, 'other'), { recursive: true });
  assert.throws(() => syncSkill(options), /Missing checkout/);
  assert.throws(() => syncSkill({ ...options, names: ['absent'] }), /Unknown target/);
});

test('every configured replacement still applies to the maintained skill', () => {
  // Runs without the other checkouts, so CI catches a reworded source line.
  const sourceRoot = path.join(__dirname, '..', SOURCE);
  for (const [name, target] of Object.entries(TARGETS)) {
    const rendered = render(sourceRoot, target);
    assert.ok(rendered.has('SKILL.md'), name);
    for (const { file, from, to } of target.replacements) {
      const text = rendered.get(file).toString('utf8');
      assert.ok(text.includes(to), `${name}: ${file}`);
      assert.equal(text.includes(from), false, `${name}: ${file}`);
    }
  }
});
