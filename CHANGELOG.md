# Changelog

All notable changes to acp-connector will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.0] - 2026-09-06

### Added
- Project scaffold: package.json, bin entry, ES modules
- Config loader for `.config.jsonc` (JSONC parser with comment/trailing comma stripping)
- Interactive setup wizard (`acp-connector setup`) — prompts for Telegram token, agent command, chat ID
- Bridge entrypoint with startup banner and placeholder modules
- Example config (`.config.example.jsonc`) with documented options
- AGENTS.md and README.md

### Notes
- This is an initial scaffold. No functionality is wired yet — ACP client, Telegram bot, cron, and HTTP are placeholders.
- Designed to be agent-agnostic: any ACP-compatible agent can be configured via `agentCmd`.
