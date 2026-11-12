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
const TARGETS = {
  'remote-device-plugin-claude': {
    directory: 'plugins/remote-device-hub/skills/remote-device-operations',
    replacements: [
      {
        file: 'SKILL.md',
        from: '(`/mcp` in Claude Code or Copilot)',
        to: '(`/mcp` in Claude Code)',
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
