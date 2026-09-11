import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { request } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type StreamableHttpService,
  getRuntimeConfig,
  startStreamableHttpServer,
} from '../src/runtime.js';

vi.mock('undici');

describe('runtime configuration', () => {
  it('defaults to stdio', () => {
    expect(getRuntimeConfig({})).toEqual({
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      path: '/mcp',
      allowedHosts: undefined,
      allowedOrigins: undefined,
    });
  });

  it('reads the streamable HTTP options from the environment', () => {
    expect(
      getRuntimeConfig({
        MCP_TRANSPORT: 'streamable-http',
        MCP_HOST: '0.0.0.0',
        MCP_PORT: '8080',
        MCP_PATH: 'rpc',
        MCP_ALLOWED_HOSTS: 'example.test:8080, other.test:8080',
        MCP_ALLOWED_ORIGINS: 'https://example.test',
      })
    ).toEqual({
      transport: 'streamable-http',
      host: '0.0.0.0',
      port: 8080,
      path: '/rpc',
      allowedHosts: ['example.test:8080', 'other.test:8080'],
      allowedOrigins: ['https://example.test'],
    });
  });

  it('rejects a port outside the valid range', () => {
    expect(() => getRuntimeConfig({ MCP_PORT: '70000' })).toThrow();
  });
});

describe('streamable HTTP runtime', () => {
  let service: StreamableHttpService | undefined;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_RED_URL = 'http://localhost:1880';
    process.env.NODE_RED_TOKEN = 'test-token';
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service?.close();
    service = undefined;
    process.env = originalEnv;
  });

  async function startOnRandomPort() {
    service = await startStreamableHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp' });
    return service;
  }

  function connect(endpoint: string) {
    const client = new Client({ name: 'runtime-test-client', version: '1.0.0' });
    return { client, transport: new StreamableHTTPClientTransport(new URL(endpoint)) };
  }

  it('serves the tool listing over HTTP', async () => {
    const { endpoint } = await startOnRandomPort();
    const { client, transport } = connect(endpoint);

    await client.connect(transport);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain('list_flows');
    await client.close();
  });

  it('completes a tool call that has to wait on Node-RED', async () => {
    // The response to a call is written after handleRequest has already returned, so this is the
    // case that breaks if the transport is torn down as soon as handleRequest resolves.
    vi.mocked(request).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        statusCode: 200,
        body: {
          json: async () => ({ rev: 'r1', flows: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }] }),
          text: async () => '',
        },
      } as never;
    });

    const { endpoint } = await startOnRandomPort();
    const { client, transport } = connect(endpoint);

    await client.connect(transport);
    const result = (await client.callTool({ name: 'list_flows', arguments: {} })) as {
      content: Array<{ text: string }>;
    };

    expect(JSON.parse(result.content[0].text)).toEqual([
      { id: 'tab1', label: 'Flow 1', type: 'tab' },
    ]);
    await client.close();
  });

  it('rejects a Host header that was not allowed', async () => {
    // fetch will not let a caller set Host, so go through node:http to forge it.
    const { host, port, path } = await startOnRandomPort();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host,
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Host: 'evil.test',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(statusCode).toBe(403);
  });

  it('accepts localhost as well as the bound loopback address', async () => {
    const { port, path } = await startOnRandomPort();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Host: `localhost:${port}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(statusCode).toBe(200);
  });

  it('rejects methods other than POST', async () => {
    const { endpoint } = await startOnRandomPort();
    const response = await fetch(endpoint, { method: 'PUT' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('returns 404 for other paths', async () => {
    const { host, port } = await startOnRandomPort();
    const response = await fetch(`http://${host}:${port}/somewhere-else`, { method: 'POST' });

    expect(response.status).toBe(404);
  });

  it('rejects a body that is not JSON', async () => {
    const { endpoint } = await startOnRandomPort();
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });
});
