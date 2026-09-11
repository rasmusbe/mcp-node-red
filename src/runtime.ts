import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createServer } from './server.js';

/** Anything larger than this is not a JSON-RPC message, so read no further. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const CommaSeparated = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )
  .optional();

const RuntimeConfigSchema = z.object({
  transport: z.enum(['stdio', 'streamable-http']).default('stdio'),
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(0).max(65535).default(3000),
  path: z
    .string()
    .default('/mcp')
    .transform((value) => (value.startsWith('/') ? value : `/${value}`)),
  allowedHosts: CommaSeparated,
  allowedOrigins: CommaSeparated,
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export interface StreamableHttpService {
  close(): Promise<void>;
  endpoint: string;
  host: string;
  path: string;
  port: number;
}

export function getRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return RuntimeConfigSchema.parse({
    transport: env.MCP_TRANSPORT,
    host: env.MCP_HOST,
    port: env.MCP_PORT,
    path: env.MCP_PATH,
    allowedHosts: env.MCP_ALLOWED_HOSTS,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS,
  });
}

/**
 * Host header values to accept when none were configured.
 *
 * A browser on the user's machine can be pointed at a loopback port by any page it loads, and
 * this server carries a Node-RED admin token, so the Host header is checked. The client decides
 * how it spells the address, and 127.0.0.1 and localhost are the same server, so accept both
 * rather than only the form the listener was bound to.
 */
function defaultAllowedHosts(host: string, port: number): string[] {
  const names = new Set([host]);
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    names.add('127.0.0.1');
    names.add('localhost');
    names.add('[::1]');
  }
  return [...names].map((name) => `${name}:${port}`);
}

function jsonRpcError(res: ServerResponse, statusCode: number, message: string, code = -32000) {
  if (res.headersSent) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body.length === 0 ? undefined : JSON.parse(body);
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export async function runStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function createStreamableHttpRequestHandler(
  config: Pick<RuntimeConfig, 'path' | 'allowedHosts' | 'allowedOrigins'>
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');

    if (requestUrl.pathname !== config.path) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      jsonRpcError(res, 405, 'Method not allowed');
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'Request body too large';
      jsonRpcError(
        res,
        tooLarge ? 413 : 400,
        tooLarge ? error.message : 'Invalid JSON body',
        -32700
      );
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
    });

    // handleRequest returns once the request has been dispatched, not once the response has been
    // written: for a call it opens an SSE stream and the result is sent later, when the handler
    // resolves. Tear down when the response closes, or the stream ends before the result reaches
    // the client.
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error('Error handling MCP HTTP request:', error);
      jsonRpcError(res, 500, 'Internal server error', -32603);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

export async function startStreamableHttpServer(
  runtimeConfig: Partial<RuntimeConfig> = {}
): Promise<StreamableHttpService> {
  const config = RuntimeConfigSchema.parse(runtimeConfig);

  // Filled in once the listener is bound, because port 0 means the port is not known until then.
  let allowedHosts = config.allowedHosts;

  const httpServer = createHttpServer((req, res) => {
    void createStreamableHttpRequestHandler({
      path: config.path,
      allowedHosts,
      allowedOrigins: config.allowedOrigins,
    })(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine HTTP server address');
  }

  allowedHosts ??= defaultAllowedHosts(config.host, address.port);

  return {
    host: address.address,
    path: config.path,
    port: address.port,
    endpoint: `http://${formatHostForUrl(address.address)}:${address.port}${config.path}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function runStreamableHttpServer(
  runtimeConfig: Partial<RuntimeConfig> = {}
): Promise<StreamableHttpService> {
  const service = await startStreamableHttpServer(RuntimeConfigSchema.parse(runtimeConfig));

  console.error(`MCP Streamable HTTP server listening at ${service.endpoint}`);

  const shutdown = async () => {
    await service.close().catch((error) => {
      console.error('Error while shutting down MCP HTTP server:', error);
    });
  };

  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

  return service;
}

export async function runServer(): Promise<void> {
  const config = getRuntimeConfig();

  if (config.transport === 'streamable-http') {
    await runStreamableHttpServer(config);
    return;
  }

  await runStdioServer();
}
