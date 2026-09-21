/**
 * A minimal Model Context Protocol server over HTTP.
 *
 * MCP is JSON-RPC 2.0. The whole surface this needs is four methods, so
 * rather than take an SDK dependency the dispatch lives here as a pure
 * function: request in, response out, no I/O of its own. That is what makes it
 * testable without a database or a network.
 *
 * Stateless by design — no session id is issued or required. Each call carries
 * its own bearer token and stands alone, which is what suits a serverless
 * function that may answer two calls from two different instances.
 */

export const PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC's reserved codes, the only ones this server uses. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Present and true when the tool changes state or spends API quota. */
  destructive?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/**
 * Which methods need a credential.
 *
 * Handshake and discovery are deliberately open. A client that must
 * authenticate before it can even ask what a server is looks, to Claude's
 * connector flow, exactly like a server demanding OAuth — it sees the 401,
 * goes hunting for a sign-in service, and fails to register with one that
 * does not exist. Answering `initialize` and `tools/list` in the clear costs
 * nothing (tool names and descriptions, no data, no actions) and is what
 * every remote MCP server that connects cleanly actually does.
 *
 * Everything that touches data or spends API quota still needs the token.
 */
function needsAuth(method: string): boolean {
  return method === 'tools/call';
}

/**
 * Handle one request. Returns null for a notification, which by JSON-RPC's
 * rules gets no response body at all.
 *
 * `authorized` is consulted only for the methods that need it, so an
 * unauthenticated client can still complete a handshake and see the tool list.
 */
export async function dispatch(
  req: JsonRpcRequest,
  tools: McpTool[],
  info: ServerInfo,
  authorized: () => Promise<boolean> = async () => true
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  const method = req.method;

  if (!method) return fail(id, RPC.INVALID_REQUEST, 'Missing method.');

  // Notifications carry no id and expect no answer.
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const asked = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version },
        ...(info.instructions ? { instructions: info.instructions } : {}),
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          ...(t.title ? { title: t.title } : {}),
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: {
            readOnlyHint: !t.destructive,
            destructiveHint: false,
            idempotentHint: !t.destructive,
            openWorldHint: Boolean(t.destructive),
          },
        })),
      });

    case 'tools/call': {
      if (needsAuth(method) && !(await authorized())) {
        // Reported as a failed tool call rather than an HTTP 401: a transport
        // error here sends the client back into the OAuth hunt, while this
        // puts a readable reason in front of whoever is holding it wrong.
        return ok(id, {
          content: [
            {
              type: 'text',
              text:
                'Not authorized. This server needs its MCP access token, either as ' +
                'an Authorization: Bearer header or an ?apikey= query parameter on ' +
                'the server URL. Set one on /settings if there is none.',
            },
          ],
          isError: true,
        });
      }

      const name = req.params?.name;
      if (typeof name !== 'string') {
        return fail(id, RPC.INVALID_PARAMS, 'tools/call needs a tool name.');
      }
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(id, RPC.METHOD_NOT_FOUND, `No such tool: ${name}`);

      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const value = await tool.handler(args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        });
      } catch (e) {
        // A tool that throws is a failed tool call, not a broken protocol —
        // report it inside a successful JSON-RPC result so the model can read
        // the reason and decide what to do rather than seeing a transport error.
        const message = e instanceof Error ? e.message : 'Tool failed.';
        return ok(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }

    default:
      return fail(id, RPC.METHOD_NOT_FOUND, `Unsupported method: ${method}`);
  }
}
