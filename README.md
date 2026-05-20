# @btx/mcp-gateway

> ⚠️ **Status**: 0.0.1 — scaffold only. Meat ships Day 5-6 of the 9-day plan. See [`@btx/challenges-sdk`](https://github.com/btx-tools/btx-challenges-sdk) for the core admission primitive.

MCP server reference implementation with per-tool-call BTX service-challenge admission.

When an AI agent calls a tool exposed by this MCP server, the agent must first solve a BTX MatMul proof-of-work puzzle (~1-4 seconds) and submit the proof. The server redeems the proof atomically (no replay) before running the tool.

## Why

Agentic AI systems need better admission control than API keys + rate limits. BTX service challenges price each tool call in compute, naturally rate-limiting runaway agents while staying invisible to legitimate use.

## Roadmap

| Day | Item |
|---|---|
| ⏳ Day 5 | MCP server skeleton + per-tool-call BTX gate wrapper |
| ⏳ Day 5 | Example tool: `echo` (low difficulty) |
| ⏳ Day 5 | Example tool: `calendar.write` (higher difficulty, privileged) |
| ⏳ Day 6 | MCP client example that solves + retries |
| ⏳ Day 6 | Compliance test against canonical MCP client (Claude Desktop / mcp-cli) |

## Links

- Companion SDK: [@btx/challenges-sdk](https://github.com/btx-tools/btx-challenges-sdk)
- MCP spec: [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-03-26)
- BTX dev portal: [btx.dev/develop](https://btx.dev/develop/)

## License

MIT
