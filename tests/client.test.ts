import { Agent, request } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  FlowsConflictError,
  HEADERS_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  NODE_SET_CACHE_TTL_MS,
  NodeRedClient,
  RETRY_DELAY_MS,
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

  describe('getFlows key order', () => {
    it('should hand back the flows exactly as Node-RED sent them', async () => {
      // setFlows writes this list back, and Zod's passthrough would emit wires ahead of x and y.
      const mockFlows = {
        rev: 'abc123',
        flows: [{ id: 'n1', type: 'inject', x: 100, y: 80, wires: [[]], z: 'tab1' }],
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(mockFlows), text: vi.fn() },
      } as any);

      const result = await client.getFlows();

      expect(Object.keys(result.flows[0])).toEqual(['id', 'type', 'x', 'y', 'wires', 'z']);
    });
  });

  describe('listTabs', () => {
    const respondWith = (flows: unknown[]) => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({ rev: 'abc123', flows }), text: vi.fn() },
      } as any);
    };

    it('should keep the tabs and drop everything else', async () => {
      respondWith([
        { id: '1', type: 'tab', label: 'Flow 1' },
        { id: 'n1', type: 'inject', z: '1', name: 'Inject', wires: [['n2']] },
        { id: 'sf1', type: 'subflow', name: 'My Subflow' },
        { id: '2', type: 'tab', label: 'Flow 2' },
      ]);

      const result = await client.listTabs();

      expect(result).toEqual([
        { id: '1', label: 'Flow 1', disabled: undefined },
        { id: '2', label: 'Flow 2', disabled: undefined },
      ]);
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

    it('should report a disabled tab', async () => {
      respondWith([{ id: '1', type: 'tab', label: 'Flow 1', disabled: true }]);

      await expect(client.listTabs()).resolves.toEqual([
        { id: '1', label: 'Flow 1', disabled: true },
      ]);
    });

    it('should strip the properties a tab listing does not use', async () => {
      respondWith([{ id: '1', type: 'tab', label: 'Flow 1', info: 'notes', env: [] }]);

      const [tab] = await client.listTabs();

      expect(tab).not.toHaveProperty('info');
      expect(tab).not.toHaveProperty('env');
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: { text: vi.fn().mockResolvedValue('Internal Server Error') },
      } as any);

      await expect(client.listTabs()).rejects.toThrow('Failed to get flows: 500');
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
    const nodeSets = [
      {
        id: 'node-red/inject',
        name: 'inject',
        types: ['inject'],
        enabled: true,
        module: 'node-red',
        version: '5.0.6',
        local: false,
        user: false,
      },
      {
        id: 'node-red/link',
        name: 'link',
        types: ['link in', 'link out'],
        enabled: true,
        module: 'node-red',
        version: '5.0.6',
      },
    ];

    const respondWithSets = (sets: unknown = nodeSets) => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(sets), text: vi.fn() },
      } as any);
    };

    it('should fetch the flat node set list', async () => {
      respondWithSets();

      const result = await client.getNodes();

      expect(result).toEqual(nodeSets);
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

    it('should accept a set without the optional fields', async () => {
      respondWithSets([
        {
          id: 'node-red/inject',
          name: 'inject',
          types: ['inject'],
          enabled: true,
          module: 'node-red',
        },
      ]);

      const result = await client.getNodes();

      expect(result[0].version).toBeUndefined();
      expect(result[0].local).toBeUndefined();
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

    it('should serve a cached call from the last fetch', async () => {
      respondWithSets();

      await client.getNodes();
      const result = await client.getNodes({ cached: true });

      expect(result).toEqual(nodeSets);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('should always fetch when the cache is not asked for', async () => {
      respondWithSets();

      await client.getNodes();
      await client.getNodes();

      expect(request).toHaveBeenCalledTimes(2);
    });

    it('should fetch again once the cached list has expired', async () => {
      vi.useFakeTimers();
      respondWithSets();

      try {
        await client.getNodes({ cached: true });
        vi.advanceTimersByTime(NODE_SET_CACHE_TTL_MS + 1);
        await client.getNodes({ cached: true });
      } finally {
        vi.useRealTimers();
      }

      expect(request).toHaveBeenCalledTimes(2);
    });

    it('should share one request between concurrent cached calls', async () => {
      respondWithSets();

      const [first, second] = await Promise.all([
        client.getNodes({ cached: true }),
        client.getNodes({ cached: true }),
      ]);

      expect(first).toEqual(nodeSets);
      expect(second).toEqual(nodeSets);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('should not remember a failed fetch as the request in flight', async () => {
      vi.mocked(request).mockResolvedValueOnce({
        statusCode: 500,
        body: { text: vi.fn().mockResolvedValue('boom') },
      } as any);

      await expect(client.getNodes({ cached: true })).rejects.toThrow('Failed to get nodes: 500');

      respondWithSets();
      await expect(client.getNodes({ cached: true })).resolves.toEqual(nodeSets);
    });

    it('should drop the cache after installing a module', async () => {
      respondWithSets();
      await client.getNodes();

      vi.mocked(request).mockResolvedValueOnce({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({ name: 'node-red-contrib-foo', version: '1.0.0' }),
          text: vi.fn(),
        },
      } as any);
      await client.installNode('node-red-contrib-foo');

      respondWithSets();
      await client.getNodes({ cached: true });

      expect(request).toHaveBeenCalledTimes(3);
    });

    it('should drop the cache after enabling or disabling a module', async () => {
      respondWithSets();
      await client.getNodes();

      vi.mocked(request).mockResolvedValueOnce({
        statusCode: 200,
        body: {
          json: vi.fn().mockResolvedValue({ name: 'node-red-contrib-foo', version: '1.0.0' }),
          text: vi.fn(),
        },
      } as any);
      await client.setNodeModuleState('node-red-contrib-foo', false);

      respondWithSets();
      await client.getNodes({ cached: true });

      expect(request).toHaveBeenCalledTimes(3);
    });

    it('should drop the cache after removing a module', async () => {
      respondWithSets();
      await client.getNodes();

      vi.mocked(request).mockResolvedValueOnce({
        statusCode: 204,
        body: { json: vi.fn(), text: vi.fn() },
      } as any);
      await client.removeNodeModule('node-red-contrib-foo');

      respondWithSets();
      await client.getNodes({ cached: true });

      expect(request).toHaveBeenCalledTimes(3);
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

  describe('setFlows', () => {
    const flows = [{ id: 'cfg1', type: 'mqtt-broker' }];

    const respond = (statusCode: number, body: unknown) => {
      vi.mocked(request).mockResolvedValue({
        statusCode,
        body: {
          json: vi.fn().mockResolvedValue(body),
          text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
        },
      } as any);
    };

    it('should post the rev, the flows and the deployment type', async () => {
      respond(200, { rev: 'rev2' });

      const result = await client.setFlows(flows, 'rev1');

      expect(result).toEqual({ rev: 'rev2' });
      expect(request).toHaveBeenCalledWith('http://localhost:1880/flows', {
        method: 'POST',
        dispatcher: nodeRedAgent,
        headers: expect.objectContaining({
          'Node-RED-API-Version': 'v2',
          'Node-RED-Deployment-Type': 'nodes',
        }),
        body: JSON.stringify({ rev: 'rev1', flows }),
      });
    });

    it('should send the deployment type it is given', async () => {
      respond(200, { rev: 'rev2' });

      await client.setFlows(flows, 'rev1', 'full');

      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/flows',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Node-RED-Deployment-Type': 'full' }),
        })
      );
    });

    it('should throw a FlowsConflictError with the body message on 409', async () => {
      respond(409, { code: 'version_mismatch', message: 'Flows have changed' });

      const error = await client.setFlows(flows, 'stale').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FlowsConflictError);
      expect((error as Error).name).toBe('FlowsConflictError');
      expect((error as Error).message).toBe('Flows have changed');
    });

    it('should describe the conflict itself when the 409 body carries no message', async () => {
      respond(409, '');

      await expect(client.setFlows(flows, 'stale')).rejects.toThrow(
        'The Node-RED configuration changed since it was read'
      );
    });

    it('should throw on any other error status', async () => {
      respond(400, 'Bad Request');

      const error = await client.setFlows(flows, 'rev1').catch((caught: unknown) => caught);

      expect(error).not.toBeInstanceOf(FlowsConflictError);
      expect((error as Error).message).toContain('Failed to set flows: 400');
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

    it('should share the node set cache with the client it came from', async () => {
      const controller = new AbortController();
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue([]), text: vi.fn() },
      } as any);

      await client.getNodes();
      await client.withSignal(controller.signal).getNodes({ cached: true });

      expect(request).toHaveBeenCalledTimes(1);
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
  describe('connection retry', () => {
    const okFlows = { rev: 'a', flows: [] };
    const connectionError = (code: string) =>
      Object.assign(new Error(`socket hang up (${code})`), { code });

    const okResponse = () =>
      ({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(okFlows), text: vi.fn() },
      }) as any;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Run a call and let the retry delay pass. The outcome is captured before the timers move so
     * a rejection is never left unhandled while the fake clock ticks.
     */
    const settle = async <T>(run: () => Promise<T>): Promise<T> => {
      const outcome = run().then(
        (value) => () => value,
        (error: unknown) => () => {
          throw error;
        }
      );

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
      return (await outcome)();
    };

    it('should retry a GET once after a refused connection', async () => {
      vi.mocked(request)
        .mockRejectedValueOnce(connectionError('ECONNREFUSED'))
        .mockResolvedValueOnce(okResponse());

      await expect(settle(() => client.getFlows())).resolves.toEqual(okFlows);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('should retry when the code is on the cause', async () => {
      const error = new Error('fetch failed');
      (error as { cause?: unknown }).cause = { code: 'ECONNRESET' };
      vi.mocked(request).mockRejectedValueOnce(error).mockResolvedValueOnce(okResponse());

      await expect(settle(() => client.getFlows())).resolves.toEqual(okFlows);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('should give up when the retry fails as well', async () => {
      vi.mocked(request).mockRejectedValue(connectionError('ECONNREFUSED'));

      await expect(settle(() => client.getFlows())).rejects.toThrow('ECONNREFUSED');
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('should not retry a write', async () => {
      vi.mocked(request).mockRejectedValue(connectionError('ECONNREFUSED'));

      await expect(settle(() => client.createFlow({ id: 'f1', label: 'Flow' }))).rejects.toThrow(
        'ECONNREFUSED'
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('should not retry once the caller has cancelled', async () => {
      const controller = new AbortController();
      controller.abort();
      vi.mocked(request).mockRejectedValue(connectionError('ECONNRESET'));

      await expect(settle(() => client.withSignal(controller.signal).getFlows())).rejects.toThrow(
        'ECONNRESET'
      );
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('should not retry an error that is not a connection failure', async () => {
      vi.mocked(request).mockRejectedValue(connectionError('UND_ERR_HEADERS_TIMEOUT'));

      await expect(settle(() => client.getFlows())).rejects.toThrow('UND_ERR_HEADERS_TIMEOUT');
      expect(request).toHaveBeenCalledTimes(1);
    });
  });
});
