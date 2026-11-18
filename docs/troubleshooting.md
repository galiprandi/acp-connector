# Troubleshooting

← Back to [README](../README.md)

## `Conflict: terminated by other getUpdates request`

Another bot instance is running with the same token. Kill it:

```bash
pkill -f acp-connector
```

## Agent doesn't respond

1. Check that `agentCmd` launches your agent correctly: run it manually
2. Check the bridge console for errors
3. Ensure your chat ID is in `allowedChatIds`

## MCP servers not loading

If you configured `sessionConfigPath`, verify the file exists and is valid JSONC. The bridge logs errors reading it but doesn't crash.

## Telegram rate limits

The bridge batches stream edits (800ms) to avoid rate limits. If you still hit limits, disable streaming (`"streaming": false`) to send one message per response instead.
