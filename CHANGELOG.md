# Changelog

All notable changes to the Remote Device Hub VS Code extension are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.28] - 2026-11-12

### Changed

- Rewrote the Marketplace overview: value proposition, architecture diagram,
  example prompts, and a three-step quick start now come first; contributor
  details stay below.
- Sharpened the Marketplace description and keywords, and moved the categories
  to `AI` and `Chat`.

## [0.0.27] - 2026-11-12

### Added

- Agent Plugins 1.0 package (`plugin.json`, `mcp.json`, `skills/remote-device-operations/`)
  for agent clients that do not load the extension.
- `remote-device-operations` skill, contributed by the extension through
  `contributes.chatSkills` and shipped in both the VSIX and the plugin package.
- `capabilities.untrustedWorkspaces` set to `limited`, so the extension loads in
  Restricted Mode with Read only and Ask for approval. Full access and per-task
  device grants still require a trusted workspace.

### Changed

- The extension's MCP server label is now `remote-device-hub`, matching the agent
  plugin, so VS Code's name-based MCP server deduplication applies.
- Activation and MCP definition discovery no longer read credentials, contact RDH,
  or start authentication. Sign-in and background refresh begin on first use.
- Requires VS Code 1.118 or later.
- `@types/vscode` is pinned to the declared minimum, so the build cannot use APIs
  that are unavailable in the supported editor.
- The MCP `initialize` request reports the installed extension version instead of
  a fixed value.

### Fixed

- The credential lock identifies its listener with a scope-bound greeting and
  scans candidate ports, so an unrelated local service on the derived port no
  longer blocks sign-in until the timeout expires.
- A credential check that finishes after another window signs out or switches
  accounts no longer hands the earlier token to the MCP provider.

## [0.0.26] - 2026-11-09

- Last release published without a changelog. See the Git history and GitHub
  releases for earlier changes.

[Unreleased]: https://github.com/easelian/remote-device-plugin-vscode/compare/v0.0.28...HEAD
[0.0.28]: https://github.com/easelian/remote-device-plugin-vscode/compare/v0.0.27...v0.0.28
[0.0.27]: https://github.com/easelian/remote-device-plugin-vscode/compare/v0.0.26...v0.0.27
[0.0.26]: https://github.com/easelian/remote-device-plugin-vscode/releases/tag/v0.0.26
