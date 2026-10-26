#!/bin/sh
# Boot an agent container:
#  1. First run: seed /data with the assistant template.
#  2. Write acp-connector.jsonc from env vars (TELEGRAM_TOKEN, etc.).
#  3. Start the bridge — opencode acp is the agent.
set -e

if [ ! -f /data/AGENTS.md ]; then
  echo "First run — installing assistant template into /data"
  cp -r /opt/assistant/. /data/
fi

if [ ! -f /data/acp-connector.jsonc ]; then
  echo "Writing acp-connector.jsonc from environment"
  {
    echo "{"
    echo "  \"agentCmd\": \"${AGENT_CMD:-opencode acp}\","
    echo "  \"platforms\": {"
    echo "    \"telegram\": { \"token\": \"${TELEGRAM_TOKEN}\" }"
    [ -n "$DISCORD_TOKEN" ] && echo "    ,\"discord\": { \"token\": \"$DISCORD_TOKEN\" }"
    echo "  },"
    echo "  \"media\": { \"uploadsDir\": \"uploads\" }"
    echo "}"
  } > /data/acp-connector.jsonc
fi

if [ -z "$TELEGRAM_TOKEN" ] && [ -z "$DISCORD_TOKEN" ]; then
  echo "WARNING: no TELEGRAM_TOKEN or DISCORD_TOKEN set — bridge starts headless."
fi

exec acp-connector
