# Deployment

← Back to [README](../README.md)

## assistant-setup wizard (experimental)

`assistant-setup` is a single-file binary (compiled with `bun build --compile`)
that bootstraps a personal AI assistant from the
[galiprandi/assistant](https://github.com/galiprandi/assistant) template —
no Node, git, or package manager required on the target machine.

What it does:

1. Detects agent CLIs in `PATH` (devin, claude, opencode, agy, pi) and
   best-effort flags ones that look logged in.
2. Asks for an install directory (default `~/my-assistant`).
3. Downloads the template tarball and extracts it there.
4. Optionally writes a minimal `acp-connector.jsonc` for a Telegram bot.
5. Optionally installs autostart on boot — **opt-in only** — via the native
   mechanism: `systemd --user` (Linux), launchd `LaunchAgent` (macOS), or
   Task Scheduler (Windows).
6. Hands off to the detected agent with the template's setup prompt
   (`claude -p`, `opencode run`; interactive agents launch with the prompt
   printed to paste).

Build the binaries (requires [Bun](https://bun.sh) on the build machine only):

```bash
pnpm build:wizard
# → dist-wizard/assistant-setup-linux-x64
#   dist-wizard/assistant-setup-macos-arm64
#   dist-wizard/assistant-setup-windows-x64.exe
```

On every push to `main` that touches `src/`, the `wizard.yml` workflow
rebuilds all binaries — wizard *and* bridge — and attaches them to the latest
release, so downloads always ship the current build.

Distribute the binary; end users just run `./assistant-setup`.

## Container image (server flavor)

`container/Dockerfile` builds an all-in-one agent image: OpenCode (free
models), acp-connector, the assistant template, Node 22 and Chromium. One
container per agent, state in a `/data` volume (identity, `.browser-profile/`,
`acp-connector.jsonc`):

```bash
docker build -f container/Dockerfile -t agent .
docker run -d --name my-agent -v my-agent-data:/data \
  -e TELEGRAM_TOKEN=<bot-token> agent
```

`container/docker-compose.example.yml` shows a multi-agent layout (one
service + volume per agent). Env vars: `TELEGRAM_TOKEN`, `DISCORD_TOKEN`,
`AGENT_CMD` (default `opencode acp`).

## Self-hosting

### systemd

```ini
[Unit]
Description=acp-connector
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/npx acp-connector
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### pm2

```bash
pm2 start npx --name acp-connector -- acp-connector
pm2 save
pm2 startup
```

## Headless mode

The bridge can run with **no messaging platform at all** — see
[Headless mode](a2a.md#headless-mode) in the A2A docs.
