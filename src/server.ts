/**
 * `createBtxMcpServer` — factory that wires BTX-wrapped tools into an MCP
 * `McpServer` instance.
 *
 * Caller decides which transport to attach (stdio / HTTP+SSE / custom). The
 * returned server is ready to `.connect(transport)`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { CreateBtxMcpServerOpts } from './types.js';

/**
 * Construct an MCP server with BTX admission-gated tools.
 *
 * @example
 * ```ts
 * import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
 * import { createBtxMcpServer, btxToolWrapper } from '@btx-tools/mcp-gateway';
 *
 * const server = createBtxMcpServer({
 *   name: 'my-gated-tools',
 *   version: '0.1.0',
 *   tools: [
 *     btxToolWrapper({ ... }),
 *     btxToolWrapper({ ... }),
 *   ],
 * });
 *
 * await server.connect(new StdioServerTransport());
 * ```
 */
export function createBtxMcpServer(opts: CreateBtxMcpServerOpts): McpServer {
  const server = new McpServer(
    {
      name: opts.name,
      version: opts.version,
    },
    opts.instructions ? { instructions: opts.instructions } : undefined,
  );

  for (const tool of opts.tools) {
    // Audit MED-4/5: forward title, outputSchema, annotations, _meta when
    // adopters supplied them via BtxToolDefinition. Without this they were
    // silently dropped in 0.1.0. The MCP SDK's registerTool has multiple
    // generic overloads → Parameters<...>[1] resolves to `never`; use a
    // structural record + cast at the call site instead.
    const config: Record<string, unknown> = {
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (tool.title !== undefined) config.title = tool.title;
    if (tool.outputSchema !== undefined) config.outputSchema = tool.outputSchema;
    if (tool.annotations !== undefined) config.annotations = tool.annotations;
    if (tool._meta !== undefined) config._meta = tool._meta;

    server.registerTool(
      tool.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config as any,
      // The MCP SDK passes parsed-and-validated args + extra context; our
      // wrapper signature matches.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool.callback as any,
    );
  }

  return server;
}
