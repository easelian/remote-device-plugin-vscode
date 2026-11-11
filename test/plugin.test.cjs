const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = readJson('package.json');

function frontmatter(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match, `${file} must start with YAML frontmatter`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(line);
    if (field) {
      fields[field[1]] = field[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return fields;
}

test('the plugin manifest follows the Agent Plugins schema', () => {
  const plugin = readJson('plugin.json');
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  // Published artifacts must not drift: the plugin ships from this repository.
  assert.equal(plugin.version, manifest.version);
  assert.ok(plugin.description.trim());
  assert.equal(plugin.license, manifest.license);
});

test('the plugin MCP configuration stays portable and credential free', () => {
  const config = readJson('mcp.json');
  assert.equal(config.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'mcpServers']);
  const servers = Object.entries(config.mcpServers);
  assert.ok(servers.length > 0);
  for (const [name, server] of servers) {
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(['stdio', 'streamable-http', 'sse'].includes(server.type), `${name} transport`);
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      // Configured headers are visible package data. RDH authenticates with its
      // own OAuth flow, so no credential may be written into the manifest.
      assert.doesNotMatch(`${header}: ${value}`, /authorization|bearer|token|secret/i);
    }
    if (server.type !== 'stdio') {
      const url = new URL(server.url);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.username, '');
      assert.equal(url.password, '');
      assert.equal(url.hash, '');
    }
  }
});

test('plugin skills are well formed and match the extension contribution', () => {
  const skills = path.join(root, 'skills');
  const names = fs
    .readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.length > 0);

  const contributed = new Set();
  for (const skill of manifest.contributes.chatSkills ?? []) {
    const target = path.join(root, skill.path);
    assert.ok(fs.existsSync(target), `${skill.path} must exist`);
    assert.equal(path.basename(target), 'SKILL.md');
    contributed.add(path.basename(path.dirname(target)));
  }
  assert.deepEqual([...contributed].sort(), names, 'every skill is contributed once');

  for (const name of names) {
    const file = path.join(skills, name, 'SKILL.md');
    const fields = frontmatter(fs.readFileSync(file, 'utf8'), file);
    assert.equal(fields.name, name, 'SKILL.md name must match its directory');
    assert.match(fields.description ?? '', /\S/, `${name} needs a description`);
    assert.ok(fields.description.length <= 1024, `${name} description is too long`);
    assert.doesNotMatch(name, /[:/.]/, 'skill names are unprefixed');
  }
});
