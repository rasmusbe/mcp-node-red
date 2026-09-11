import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { request } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';

vi.mock('undici');

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

async function connectedClient() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, server };
}

describe('MCP Server', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw error when NODE_RED_URL is missing', () => {
    process.env.NODE_RED_URL = undefined;
    expect(() => createServer()).toThrow('NODE_RED_URL environment variable is required');
  });

  it('should create server with valid configuration', () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';
    process.env.NODE_RED_TOKEN = 'test-token';

    const server = createServer();
    expect(server).toBeDefined();
  });

  it('should create server without token', () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';
    process.env.NODE_RED_TOKEN = undefined;

    const server = createServer();
    expect(server).toBeDefined();
  });

  it('should validate URL format', () => {
    process.env.NODE_RED_URL = 'invalid-url';

    expect(() => createServer()).toThrow();
  });

  it('should list delete_flow in available tools', async () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';
    process.env.NODE_RED_TOKEN = 'test-token';

    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain('list_flows');
    expect(toolNames).toContain('get_flow');
    expect(toolNames).toContain('create_flow');
    expect(toolNames).toContain('update_flow');
    expect(toolNames).toContain('patch_flow');
    expect(toolNames).toContain('validate_flow');
    expect(toolNames).toContain('delete_flow');
    expect(toolNames).toContain('get_node_help');
    expect(toolNames).not.toContain('get_flows');

    await client.close();
    await server.close();
  });

  // The serialized tool list is sent to the model at the start of every session, so it is kept
  // small on purpose; this cap catches a description that grows back.
  it('should keep the serialized tool list small', async () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';

    const { client, server } = await connectedClient();

    const { tools } = await client.listTools();

    expect(JSON.stringify(tools).length).toBeLessThan(9500);

    await client.close();
    await server.close();
  });

  it('should report the version from package.json', async () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';

    const { client, server } = await connectedClient();

    expect(client.getServerVersion()?.version).toBe(packageJson.version);

    await client.close();
    await server.close();
  });

  it('should render a validation error as one line per issue', async () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';

    const { client, server } = await connectedClient();

    const result = (await client.callTool({ name: 'get_flow', arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Invalid input for get_flow:\n- flowId: Required');

    await client.close();
    await server.close();
  });

  it('should pass the request signal down to the HTTP client', async () => {
    process.env.NODE_RED_URL = 'http://localhost:1880';
    vi.mocked(request).mockResolvedValue({
      statusCode: 200,
      body: { json: vi.fn().mockResolvedValue({ rev: 'r1', flows: [] }), text: vi.fn() },
    } as any);

    const { client, server } = await connectedClient();

    await client.callTool({ name: 'list_flows', arguments: {} });

    expect(request).toHaveBeenCalledWith(
      'http://localhost:1880/flows',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await client.close();
    await server.close();
  });
});
