#!/usr/bin/env node
'use strict';
// Copy the RDH operating skill from this repository, its single source, into
// the other plugin distributions. --check reports drift without writing.
//
// There is no build or runtime dependency between repositories: each copy
// travels with its own release. Run with every checkout present before a
// coordinated release.
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'skills/remote-device-operations';

// Host-specific wording is the only permitted difference. Each replacement must
// match exactly once, so a reworded source line fails the sync instead of
// silently shipping another host's instructions.
const SOURCE_CONNECTION =
  "1. If the connection needs authentication, follow the host. In VS Code with the\n   Remote Device Hub extension, the extension owns sign-in: ask the user to run\n   **Remote Device Hub: Sign In** from the Command Palette, and do not start the\n   editor's own MCP OAuth for this server. In other hosts, use the host's MCP\n   server controls or connector settings (`/mcp` in Claude Code or Copilot CLI)\n   and complete OAuth for the connection selected in the current session.\n   Never request passwords, tokens, or pairing secrets in chat, read local\n   credential stores, or invent an Authorization header.";

const TARGETS = {
  'remote-device-plugin-codex': {
    directory: 'plugins/remote-device-hub/skills/remote-device-operations',
    replacements: [
      {
        file: 'SKILL.md',
        from: SOURCE_CONNECTION,
        to: "1. If the connection needs authentication, use the plugin's Connect action or\n   the host's RDH connector settings. Complete OAuth for the selected connection.\n   Do not copy a publisher's connection ID or create a private custom MCP App\n   as a workaround for an unavailable plugin. The host manages credentials;\n   never request passwords, tokens, or pairing secrets in chat, read local\n   credential stores, or invent an Authorization header.",
      },
    ],
  },
  'remote-device-plugin-dsh': {
    directory: 'skills/remote-device-hub',
    replacements: [
      {
        file: 'SKILL.md',
        from: 'name: remote-device-operations\n',
        to: 'name: remote-device-hub\n',
      },
      {
        file: 'SKILL.md',
        from: SOURCE_CONNECTION,
        to: "1. If the connection needs authentication, use the DeepSeek Harness OAuth\n   bridge. If browser sign-in does not open, ask the user to restart the plugin\n   and check the Harness logs. Never request passwords, tokens, or pairing\n   secrets in chat, read local credential stores, or invent an Authorization\n   header. The profile's approval mode controls prompts; each approval applies\n   to one tool call.",
      },
    ],
  },
  'remote-device-plugin-claude': {
    directory: 'plugins/remote-device-hub/skills/remote-device-operations',
    replacements: [
      {
        file: 'SKILL.md',
        from: SOURCE_CONNECTION,
        to: "1. If the connection needs authentication, use the host's MCP server controls\n   or connector settings for Remote Device Hub (`/mcp` in Claude Code).\n   Complete OAuth sign-in for the connection selected in the current session.\n   The host manages credentials. Never request passwords, tokens, or pairing secrets in chat,\n   read local credential stores, or invent an Authorization header.",
      },
    ],
  },
};

function listFiles(root, relative = '') {
  const files = [];
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(`Unsupported entry in a skill directory: ${path.join(root, child)}`);
    }
  }
  return files;
}

function render(sourceRoot, target) {
  const rendered = new Map();
  for (const file of listFiles(sourceRoot)) {
    rendered.set(file, fs.readFileSync(path.join(sourceRoot, file)));
  }
  for (const { file, from, to } of target.replacements ?? []) {
    const original = rendered.get(file);
    if (!original) {
      throw new Error(`Replacement names a file that is not in the skill: ${file}`);
    }
    const parts = original.toString('utf8').split(from);
    if (parts.length !== 2) {
      throw new Error(
        `Replacement in ${file} must match exactly once, found ${parts.length - 1}: ${from}`,
      );
    }
    rendered.set(file, Buffer.from(parts.join(to), 'utf8'));
  }
  return rendered;
}

function plan(sourceRoot, targetRoot, target) {
  const expected = render(sourceRoot, target);
  const existing = fs.existsSync(targetRoot) ? listFiles(targetRoot) : [];
  const write = [];
  for (const [file, data] of expected) {
    const current = path.join(targetRoot, file);
    if (!existing.includes(file) || !fs.readFileSync(current).equals(data)) {
      write.push({ file, data });
    }
  }
  return { write, remove: existing.filter((file) => !expected.has(file)) };
}

function syncSkill({ workspace, sourceRoot, names, check = false, targets = TARGETS }) {
  // Validate every target before changing any of them.
  const plans = [];
  for (const name of names ?? Object.keys(targets)) {
    const target = targets[name];
    if (!target) {
      throw new Error(`Unknown target: ${name}`);
    }
    const checkout = path.join(workspace, name);
    if (!fs.statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Missing checkout: ${checkout}; use --target to select present checkouts`);
    }
    const targetRoot = path.join(checkout, target.directory);
    plans.push({ targetRoot, ...plan(sourceRoot, targetRoot, target) });
  }
  const changes = [];
  for (const { targetRoot, write, remove } of plans) {
    for (const { file, data } of write) {
      const destination = path.join(targetRoot, file);
      changes.push(`${check ? 'Out of date' : 'Updated'}: ${destination}`);
      if (!check) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.skill-tmp`;
        fs.writeFileSync(temporary, data);
        fs.renameSync(temporary, destination);
      }
    }
    for (const file of remove) {
      const destination = path.join(targetRoot, file);
      changes.push(`${check ? 'Not in source' : 'Removed'}: ${destination}`);
      if (!check) {
        fs.unlinkSync(destination);
        let directory = path.dirname(destination);
        while (directory !== targetRoot && fs.readdirSync(directory).length === 0) {
          fs.rmdirSync(directory);
          directory = path.dirname(directory);
        }
      }
    }
  }
  return changes;
}

function main(argv) {
  const root = path.join(__dirname, '..');
  const options = { workspace: path.join(root, '..'), names: undefined, check: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
    } else if (argument === '--workspace' || argument === '--target') {
      const value = argv[++index];
      if (!value) {
        throw new Error(`${argument} needs a value`);
      }
      if (argument === '--workspace') {
        options.workspace = path.resolve(value);
      } else {
        options.names = [...(options.names ?? []), value];
      }
    } else {
      throw new Error(
        `Unknown argument: ${argument}\nUsage: sync-skill.cjs [--check] [--workspace <dir>] [--target <checkout>]...`,
      );
    }
  }
  const changes = syncSkill({ ...options, sourceRoot: path.join(root, SOURCE) });
  for (const change of changes) {
    console.log(change);
  }
  if (!changes.length) {
    console.log('Skill copies match the source.');
  }
  return options.check && changes.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`sync-skill: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

module.exports = { SOURCE, TARGETS, render, syncSkill };
