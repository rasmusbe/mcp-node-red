import { Agent, request } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  NodeRedClient,
  nodeRedAgent,
} from '../src/client.js';
import type { Config } from '../src/schemas.js';

// The client builds its Agent when the module is first imported, so read the options here,
// before the first beforeEach clears the mock.
const agentOptions = vi.mocked(Agent).mock.calls[0]?.[0];

vi.mock('undici');

describe('NodeRedClient', () => {
  let client: NodeRedClient;
  const mockConfig: Config = {
    nodeRedUrl: 'http://localhost:1880',
    nodeRedToken: 'test-token',
  };

  beforeEach(() => {
    client = new NodeRedClient(mockConfig);
    vi.clearAllMocks();
  });

  describe('getFlows', () => {
    it('should fetch flows successfully', async () => {
      const mockFlows = {
        rev: 'abc123',
        flows: [
          { id: '1', type: 'tab', label: 'Flow 1' },
          { id: '2', type: 'inject', z: '1', name: 'Inject' },
        ],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockFlows),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getFlows();

      expect(result).toEqual(mockFlows);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should parse subflows in flows response', async () => {
      const mockFlows = {
        rev: 'abc123',
        flows: [
          { id: '1', type: 'tab', label: 'Flow 1' },
          {
            id: 'sf1',
            type: 'subflow',
            name: 'My Subflow',
            in: [{ wires: [{ id: 'n1', port: 0 }] }],
            out: [{ wires: [{ id: 'n2', port: 0 }] }],
            nodes: [{ id: 'n1', type: 'function', z: 'sf1' }],
          },
        ],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockFlows),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getFlows();

      expect(result.flows).toHaveLength(2);
      expect(result.flows[1]).toMatchObject({
        id: 'sf1',
        type: 'subflow',
        name: 'My Subflow',
        in: [{ wires: [{ id: 'n1', port: 0 }] }],
        out: [{ wires: [{ id: 'n2', port: 0 }] }],
      });
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.getFlows()).rejects.toThrow('Failed to get flows: 500');
    });

    it('should work without authentication token', async () => {
      const clientNoAuth = new NodeRedClient({
        nodeRedUrl: 'http://localhost:1880',
      });

      const mockFlows = {
        rev: 'abc123',
        flows: [],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockFlows),
          text: vi.fn(),
        },
      } as any);

      await clientNoAuth.getFlows();

      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
        },
      });
    });
  });

  describe('createFlow', () => {
    it('should create flow successfully with 200 response', async () => {
      const flowData = {
        id: 'new-flow',
        label: 'New Flow',
        nodes: [],
        configs: [],
      };

      const mockResponse = { id: 'new-flow' };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockResponse),
          text: vi.fn(),
        },
      } as any);

      const result = await client.createFlow(flowData);

      expect(result).toEqual(mockResponse);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flow', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify(flowData),
      });
    });

    it('should handle 204 response by returning flowData id', async () => {
      const flowData = {
        id: 'new-flow',
        label: 'New Flow',
        nodes: [],
        configs: [],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: {
          text: vi.fn(),
        },
      } as any);

      const result = await client.createFlow(flowData);

      expect(result).toEqual({ id: 'new-flow' });
    });

    it('should return the id Node-RED generated when the flow has none', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({ id: 'generated-id' }),
          text: vi.fn(),
        },
      } as any);

      const result = await client.createFlow({ label: 'New Flow', nodes: [] });

      expect(result).toEqual({ id: 'generated-id' });
    });

    it('should throw when a 204 leaves no id to report', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn(), json: vi.fn() },
      } as any);

      await expect(client.createFlow({ label: 'New Flow' })).rejects.toThrow(
        'Node-RED returned no id'
      );
    });

    it('should throw error on failed create', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.createFlow({ id: '1', label: 'Test' })).rejects.toThrow(
        'Failed to create flow: 500'
      );
    });
  });

  describe('updateFlow', () => {
    it('should update flow successfully with 200 response', async () => {
      const flowData = {
        id: '1',
        label: 'Updated Flow',
        nodes: [],
        configs: [],
      };

      const mockResponse = { id: '1' };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockResponse),
          text: vi.fn(),
        },
      } as any);

      const result = await client.updateFlow('1', flowData);

      expect(result).toEqual(mockResponse);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flow/1', {
        method: 'PUT',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify(flowData),
      });
    });

    it('should handle 204 response by returning flowId', async () => {
      const flowData = {
        id: '1',
        label: 'Updated Flow',
        nodes: [],
        configs: [],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: {
          text: vi.fn(),
        },
      } as any);

      const result = await client.updateFlow('1', flowData);

      expect(result).toEqual({ id: '1' });
    });

    it('should throw error on failed update', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.updateFlow('1', { id: '1', label: 'Test' })).rejects.toThrow(
        'Failed to update flow: 500'
      );
    });
  });

  describe('deleteFlow', () => {
    it('should delete flow successfully', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: {
          text: vi.fn(),
        },
      } as any);

      await client.deleteFlow('flow-1');

      expect(request).toHaveBeenCalledWith('http://localhost:1880/flow/flow-1', {
        method: 'DELETE',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should throw error when flow not found', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: {
          text: vi.fn().mockResolvedValue('Not Found'),
        },
      } as any);

      await expect(client.deleteFlow('nonexistent')).rejects.toThrow('Failed to delete flow: 404');
    });
  });

  describe('validateFlow', () => {
    it('should validate flow successfully', async () => {
      const validFlow = {
        id: '1',
        label: 'Test Flow',
        nodes: [{ id: '2', type: 'inject', name: 'Test' }],
      };

      const result = await client.validateFlow(validFlow);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should detect missing required fields', async () => {
      const invalidFlow = {
        id: '',
        label: 'Test',
      };

      const result = await client.validateFlow(invalidFlow);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]).toContain('Flow missing required id field');
    });

    it('should validate nodes in flow', async () => {
      const flowWithInvalidNode = {
        id: '1',
        label: 'Test',
        nodes: [{ id: '', type: 'inject' }],
      };

      const result = await client.validateFlow(flowWithInvalidNode);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.[0]).toContain('Node missing required id field');
    });

    it('should validate config nodes', async () => {
      const flowWithInvalidConfig = {
        id: '1',
        label: 'Test',
        configs: [{ id: '', type: '' }],
      };

      const result = await client.validateFlow(flowWithInvalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it('should handle validation errors gracefully', async () => {
      const result = await client.validateFlow({ id: '1' });

      expect(result.valid).toBe(true);
    });
  });

  describe('getFlowState', () => {
    it('should get flow state successfully', async () => {
      const mockState = { state: 'start' };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockState),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getFlowState();

      expect(result).toEqual(mockState);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows/state', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should throw error when runtimeState is disabled (400)', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: {
          text: vi.fn().mockResolvedValue('runtimeState not enabled'),
        },
      } as any);

      await expect(client.getFlowState()).rejects.toThrow('Failed to get flow state: 400');
    });

    it('should throw error on server error', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.getFlowState()).rejects.toThrow('Failed to get flow state: 500');
    });
  });

  describe('setFlowState', () => {
    it('should set flow state to stop', async () => {
      const mockState = { state: 'stop' };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockState),
          text: vi.fn(),
        },
      } as any);

      const result = await client.setFlowState('stop');

      expect(result).toEqual(mockState);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows/state', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ state: 'stop' }),
      });
    });

    it('should set flow state to start', async () => {
      const mockState = { state: 'start' };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockState),
          text: vi.fn(),
        },
      } as any);

      const result = await client.setFlowState('start');

      expect(result).toEqual(mockState);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows/state', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ state: 'start' }),
      });
    });

    it('should throw error when runtimeState is disabled (400)', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: {
          text: vi.fn().mockResolvedValue('runtimeState not enabled'),
        },
      } as any);

      await expect(client.setFlowState('stop')).rejects.toThrow('Failed to set flow state: 400');
    });

    it('should throw error on server error', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.setFlowState('start')).rejects.toThrow('Failed to set flow state: 500');
    });
  });

  describe('getContext', () => {
    it('should get global context keys', async () => {
      const mockData = { key1: 'value1', key2: 'value2' };
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(mockData), text: vi.fn() },
      } as any);

      const result = await client.getContext('global');
      expect(result).toEqual(mockData);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/context/global', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should get global context by key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ msg: 'hello' }), text: vi.fn() },
      } as any);
      await client.getContext('global', undefined, 'myKey');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/global/myKey',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should encode ids and keys that contain a slash', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({}), text: vi.fn() },
      } as any);
      await client.getContext('flow', 'flow/1', 'nested/key');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/flow/flow%2F1/nested%2Fkey',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should get flow context by id', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ counter: 42 }), text: vi.fn() },
      } as any);
      await client.getContext('flow', 'flow-1');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/flow/flow-1',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should get flow context by id and key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ value: 'test' }), text: vi.fn() },
      } as any);
      await client.getContext('flow', 'flow-1', 'myKey');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/flow/flow-1/myKey',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should get node context by id and key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ value: 123 }), text: vi.fn() },
      } as any);
      await client.getContext('node', 'node-1', 'count');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/node/node-1/count',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should include store query param', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({}), text: vi.fn() },
      } as any);
      await client.getContext('global', undefined, 'myKey', 'file');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/global/myKey?store=file',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: { text: vi.fn().mockResolvedValue('Not Found') },
      } as any);
      await expect(client.getContext('flow', 'bad-id')).rejects.toThrow(
        'Failed to get context: 404'
      );
    });
  });

  describe('deleteContext', () => {
    it('should delete global context key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);
      await client.deleteContext('global', undefined, 'myKey');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/global/myKey',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should delete flow context key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);
      await client.deleteContext('flow', 'flow-1', 'counter');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/flow/flow-1/counter',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should delete node context key', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);
      await client.deleteContext('node', 'node-1', 'data');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/node/node-1/data',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should encode a key that contains a slash', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);
      await client.deleteContext('global', undefined, 'nested/key');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/global/nested%2Fkey',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should include store query param on delete', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);
      await client.deleteContext('global', undefined, 'myKey', 'file');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/context/global/myKey?store=file',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should throw error on failed delete', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: { text: vi.fn().mockResolvedValue('Not Found') },
      } as any);
      await expect(client.deleteContext('flow', 'bad-id', 'key')).rejects.toThrow(
        'Failed to delete context: 404'
      );
    });
  });

  describe('triggerInject', () => {
    it('should trigger inject node successfully', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          text: vi.fn(),
        },
      } as any);

      await client.triggerInject('node-123');

      expect(request).toHaveBeenCalledWith('http://localhost:1880/inject/node-123', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should encode a node id that contains a slash', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { text: vi.fn() },
      } as any);

      await client.triggerInject('node/123');

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/inject/node%2F123',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error when inject node not found', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: {
          text: vi.fn().mockResolvedValue('Not Found'),
        },
      } as any);

      await expect(client.triggerInject('missing-node')).rejects.toThrow(
        'Failed to trigger inject node: 404'
      );
    });

    it('should throw error on server error', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.triggerInject('node-123')).rejects.toThrow(
        'Failed to trigger inject node: 500'
      );
    });
  });

  describe('setDebugNodeState', () => {
    it('should enable debug node successfully', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          text: vi.fn(),
        },
      } as any);

      await client.setDebugNodeState('debug-1', true);

      expect(request).toHaveBeenCalledWith('http://localhost:1880/debug/debug-1/enable', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should disable debug node successfully', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 201,
        body: {
          text: vi.fn(),
        },
      } as any);

      await client.setDebugNodeState('debug-1', false);

      expect(request).toHaveBeenCalledWith('http://localhost:1880/debug/debug-1/disable', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should throw error on failure', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: {
          text: vi.fn().mockResolvedValue('Not Found'),
        },
      } as any);

      await expect(client.setDebugNodeState('debug-1', true)).rejects.toThrow(
        'Failed to enable debug node: 404'
      );
    });
  });

  describe('Basic Auth', () => {
    it('should extract credentials from URL', () => {
      const clientWithAuth = new NodeRedClient({
        nodeRedUrl: 'http://user:pass@localhost:1880',
      });

      const mockFlows = {
        rev: 'abc123',
        flows: [],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockFlows),
          text: vi.fn(),
        },
      } as any);

      clientWithAuth.getFlows();

      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
        },
      });
    });
  });

  describe('getNodes', () => {
    it('should fetch nodes successfully', async () => {
      const mockModules = [
        {
          name: 'node-red-contrib-example',
          version: '1.0.0',
          nodes: {
            example: {
              id: 'node-red-contrib-example/example',
              name: 'example',
              types: ['example-node'],
              enabled: true,
              module: 'node-red-contrib-example',
            },
          },
        },
      ];

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockModules),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getNodes();

      expect(result).toEqual(mockModules);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
          Accept: 'application/json',
        },
      });
    });

    it('should handle modules without nodes field', async () => {
      const mockModules = [
        {
          name: 'node-red',
          version: '4.1.5',
        },
        {
          name: 'node-red-contrib-example',
          version: '1.0.0',
          nodes: {
            example: {
              id: 'node-red-contrib-example/example',
              name: 'example',
              types: ['example-node'],
              enabled: true,
              module: 'node-red-contrib-example',
            },
          },
        },
      ];

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockModules),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getNodes();

      expect(result).toHaveLength(2);
      expect(result[0].nodes).toBeUndefined();
      expect(result[1].nodes).toBeDefined();
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: {
          text: vi.fn().mockResolvedValue('Internal Server Error'),
        },
      } as any);

      await expect(client.getNodes()).rejects.toThrow('Failed to get nodes: 500');
    });
  });

  describe('installNode', () => {
    it('should install node module successfully', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: {
          example: {
            id: 'node-red-contrib-example/example',
            name: 'example',
            types: ['example-node'],
            enabled: true,
            module: 'node-red-contrib-example',
          },
        },
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockModule),
          text: vi.fn(),
        },
      } as any);

      const result = await client.installNode('node-red-contrib-example');

      expect(result).toEqual(mockModule);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ module: 'node-red-contrib-example' }),
        headersTimeout: INSTALL_TIMEOUT_MS,
        bodyTimeout: INSTALL_TIMEOUT_MS,
      });
    });

    it('should throw error on failed install', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: {
          text: vi.fn().mockResolvedValue('Module not found'),
        },
      } as any);

      await expect(client.installNode('nonexistent')).rejects.toThrow(
        'Failed to install node module: 400'
      );
    });
  });

  describe('setNodeModuleState', () => {
    it('should enable a module with nodes as array', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: [
          {
            id: 'node-red-contrib-example/example',
            name: 'example',
            types: ['example-node'],
            enabled: true,
            module: 'node-red-contrib-example',
          },
        ],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockModule),
          text: vi.fn(),
        },
      } as any);

      const result = await client.setNodeModuleState('node-red-contrib-example', true);

      expect(result).toEqual(mockModule);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes/node-red-contrib-example', {
        method: 'PUT',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ enabled: true }),
      });
    });

    it('should disable a module', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: {
          example: {
            id: 'node-red-contrib-example/example',
            name: 'example',
            types: ['example-node'],
            enabled: false,
            module: 'node-red-contrib-example',
          },
        },
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockModule),
          text: vi.fn(),
        },
      } as any);

      await client.setNodeModuleState('node-red-contrib-example', false);

      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes/node-red-contrib-example', {
        method: 'PUT',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ enabled: false }),
      });
    });

    it('should keep the slash in a scoped module name', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({ name: '@scope/node-red-example', version: '1.0.0' }),
          text: vi.fn(),
        },
      } as any);

      await client.setNodeModuleState('@scope/node-red example', true);

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/nodes/@scope/node-red%20example',
        expect.objectContaining({ method: 'PUT' })
      );
    });

    it('should throw error on failed state change', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: {
          text: vi.fn().mockResolvedValue('Cannot disable core module'),
        },
      } as any);

      await expect(client.setNodeModuleState('node-red/core', true)).rejects.toThrow(
        'Failed to set node module state: 400'
      );
    });
  });

  describe('removeNodeModule', () => {
    it('should remove module successfully', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: {
          text: vi.fn(),
        },
      } as any);

      await expect(client.removeNodeModule('node-red-contrib-example')).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes/node-red-contrib-example', {
        method: 'DELETE',
        dispatcher: nodeRedAgent,
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should keep the slash in a scoped module name', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn() },
      } as any);

      await client.removeNodeModule('@scope/node-red example');

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/nodes/@scope/node-red%20example',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should throw error when removing core module', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: {
          text: vi.fn().mockResolvedValue('Cannot remove core module'),
        },
      } as any);

      await expect(client.removeNodeModule('node-red/core')).rejects.toThrow(
        'Failed to remove node module: 400'
      );
    });

    it('should throw error when module not found', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: {
          text: vi.fn().mockResolvedValue('Module not found'),
        },
      } as any);

      await expect(client.removeNodeModule('nonexistent')).rejects.toThrow(
        'Failed to remove node module: 404'
      );
    });
  });

  describe('getGlobalFlow', () => {
    it('should fetch the global flow with subflows', async () => {
      const mockGlobal = {
        id: 'global',
        configs: [],
        subflows: [
          {
            id: 'sf1',
            type: 'subflow',
            name: 'My Subflow',
            in: [],
            out: [],
            nodes: [],
          },
        ],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue(mockGlobal),
          text: vi.fn(),
        },
      } as any);

      const result = await client.getGlobalFlow();

      expect(result).toEqual(mockGlobal);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flow/global', {
        method: 'GET',
        dispatcher: nodeRedAgent,
        headers: expect.objectContaining({ 'Node-RED-API-Version': 'v2' }),
      });
    });

    it('should throw on non-200 response', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: { text: vi.fn().mockResolvedValue('error') },
      } as any);

      await expect(client.getGlobalFlow()).rejects.toThrow('Failed to get global flow: 500');
    });
  });

  describe('updateGlobalFlow', () => {
    it('should PUT the global flow and return id', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({ id: 'global' }),
          text: vi.fn(),
        },
      } as any);

      const globalFlow = { id: 'global' as const, configs: [], subflows: [] };
      const result = await client.updateGlobalFlow(globalFlow);

      expect(result).toEqual({ id: 'global' });
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flow/global', {
        method: 'PUT',
        dispatcher: nodeRedAgent,
        headers: expect.objectContaining({ 'Node-RED-API-Version': 'v2' }),
        body: JSON.stringify(globalFlow),
      });
    });

    it('should return {id: "global"} on 204 response', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 204,
        body: { text: vi.fn(), json: vi.fn() },
      } as any);

      const result = await client.updateGlobalFlow({ id: 'global' as const });
      expect(result).toEqual({ id: 'global' });
    });

    it('should throw on error response', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 400,
        body: { text: vi.fn().mockResolvedValue('Bad Request') },
      } as any);

      await expect(client.updateGlobalFlow({ id: 'global' as const })).rejects.toThrow(
        'Failed to update global flow: 400'
      );
    });
  });
  describe('request options', () => {
    it('should cap the undici timeouts, which default to 300 s', () => {
      expect(agentOptions).toEqual({
        connectTimeout: 5_000,
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      });
      expect(CONNECT_TIMEOUT_MS).toBe(5_000);
      expect(HEADERS_TIMEOUT_MS).toBe(30_000);
      expect(BODY_TIMEOUT_MS).toBe(30_000);
      expect(INSTALL_TIMEOUT_MS).toBe(300_000);
    });
  });

  describe('withSignal', () => {
    const okFlows = () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ rev: 'a', flows: [] }), text: vi.fn() },
      } as any);
    };

    it('should forward the signal and keep the credentials', async () => {
      const controller = new AbortController();
      okFlows();

      await client.withSignal(controller.signal).getFlows();

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/flows',
        expect.objectContaining({
          signal: controller.signal,
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
    });

    it('should return the same client when there is no signal', () => {
      expect(client.withSignal(undefined)).toBe(client);
    });

    it('should leave the client it came from unbound', async () => {
      const controller = new AbortController();
      okFlows();

      client.withSignal(controller.signal);
      await client.getFlows();

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/flows',
        expect.not.objectContaining({ signal: controller.signal })
      );
    });
  });

  describe('error responses', () => {
    const failWith = (statusCode: number, body: string) => {
      vi.mocked(request).mockResolvedValue({
        statusCode,
        body: { text: vi.fn().mockResolvedValue(body) },
      } as any);
    };

    const messageOf = async (): Promise<string | undefined> => {
      const error = await client.getFlows().then(
        () => undefined,
        (reason: unknown) => reason as Error
      );
      return error?.message;
    };

    it('should report the message from a JSON error body', async () => {
      failWith(400, JSON.stringify({ code: 'flows.error', message: 'Unexpected node type' }));

      await expect(messageOf()).resolves.toBe('Failed to get flows: 400 Unexpected node type');
    });

    it('should collapse and truncate a long HTML error body', async () => {
      failWith(502, `<html>\n  <body>\n    ${'unavailable '.repeat(200)}\n  </body>\n</html>`);

      const message = await messageOf();

      expect(message).toMatch(/^Failed to get flows: 502 <html> <body> unavailable /);
      // The status prefix, 500 characters of body and the truncation marker.
      expect(message).toHaveLength('Failed to get flows: 502 '.length + 503);
      expect(message?.endsWith('...')).toBe(true);
    });

    it('should leave no dangling separator when the body is empty', async () => {
      failWith(500, '');

      await expect(messageOf()).resolves.toBe('Failed to get flows: 500');
    });
  });
});
