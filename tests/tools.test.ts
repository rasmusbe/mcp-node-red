import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRedClient } from '../src/client.js';
import { createFlow } from '../src/tools/create-flow.js';
import { createGlobalConfigNode } from '../src/tools/create-global-config-node.js';
import { createSubflow } from '../src/tools/create-subflow.js';
import { deleteContext } from '../src/tools/delete-context.js';
import { deleteFlow } from '../src/tools/delete-flow.js';
import { deleteGlobalConfigNode } from '../src/tools/delete-global-config-node.js';
import { deleteSubflow } from '../src/tools/delete-subflow.js';
import { getContext } from '../src/tools/get-context.js';
import { getFlowState } from '../src/tools/get-flow-state.js';
import { getFlow } from '../src/tools/get-flow.js';
import { getNodes } from '../src/tools/get-nodes.js';
import { getSubflows } from '../src/tools/get-subflows.js';
import { installNode } from '../src/tools/install-node.js';
import { listFlows } from '../src/tools/list-flows.js';
import { removeNodeModule } from '../src/tools/remove-node-module.js';
import { textResult } from '../src/tools/result.js';
import { setDebugState } from '../src/tools/set-debug-state.js';
import { setFlowState } from '../src/tools/set-flow-state.js';
import { setNodeModuleState } from '../src/tools/set-node-module-state.js';
import { triggerInject } from '../src/tools/trigger-inject.js';
import { updateFlow } from '../src/tools/update-flow.js';
import { updateGlobalConfigNode } from '../src/tools/update-global-config-node.js';
import { updateSubflow } from '../src/tools/update-subflow.js';
import { validateFlow } from '../src/tools/validate-flow.js';

describe('Tool Handlers', () => {
  let mockClient: NodeRedClient;

  beforeEach(() => {
    mockClient = {
      getFlows: vi.fn(),
      getFlow: vi.fn(),
      createFlow: vi.fn(),
      getContext: vi.fn(),
      deleteContext: vi.fn(),
      updateFlow: vi.fn(),
      deleteFlow: vi.fn(),
      listTabs: vi.fn(),
      getFlowState: vi.fn(),
      setFlowState: vi.fn(),
      getNodes: vi.fn(),
      installNode: vi.fn(),
      setNodeModuleState: vi.fn(),
      removeNodeModule: vi.fn(),
      triggerInject: vi.fn(),
      setDebugNodeState: vi.fn(),
      getGlobalFlow: vi.fn(),
      setFlows: vi.fn(),
    } as any;
  });

  /** The flat GET /flows list the six subflow and config node tools read and write back. */
  const givenFlows = (flows: unknown[], rev = 'rev1') => {
    vi.mocked(mockClient.getFlows).mockResolvedValue({ rev, flows } as any);
    vi.mocked(mockClient.setFlows).mockResolvedValue({ rev: 'rev2' });
  };

  const postedFlows = () => vi.mocked(mockClient.setFlows).mock.calls[0]?.[0];
  const postedRev = () => vi.mocked(mockClient.setFlows).mock.calls[0]?.[1];

  describe('listFlows', () => {
    it('should return id and label for each tab', async () => {
      vi.mocked(mockClient.listTabs).mockResolvedValue([
        { id: '1', label: 'Flow 1' },
        { id: '2', label: 'Flow 2' },
      ]);

      const result = await listFlows(mockClient);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual([
        { id: '1', label: 'Flow 1' },
        { id: '2', label: 'Flow 2' },
      ]);
    });

    it('should mark a disabled tab and leave the others plain', async () => {
      vi.mocked(mockClient.listTabs).mockResolvedValue([
        { id: '1', label: 'Flow 1', disabled: false },
        { id: '2', label: 'Flow 2', disabled: true },
      ]);

      const result = await listFlows(mockClient);

      expect(JSON.parse(result.content[0].text)).toEqual([
        { id: '1', label: 'Flow 1' },
        { id: '2', label: 'Flow 2', disabled: true },
      ]);
    });
  });

  describe('getFlow', () => {
    it('should return a single flow by ID', async () => {
      const mockFlow = {
        id: 'flow1',
        label: 'My Flow',
        nodes: [{ id: 'n1', type: 'inject', z: 'flow1' }],
        configs: [],
      };

      vi.mocked(mockClient.getFlow).mockResolvedValue(mockFlow);

      const result = await getFlow(mockClient, { flowId: 'flow1' });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(mockFlow);
      expect(mockClient.getFlow).toHaveBeenCalledWith('flow1');
    });

    it('should throw when flowId is missing', async () => {
      await expect(getFlow(mockClient, {})).rejects.toThrow();
    });

    describe('selection', () => {
      const selectionFlow = {
        id: 'flow1',
        label: 'My Flow',
        disabled: false,
        info: 'Notes',
        nodes: [
          { id: 'n1', type: 'inject', z: 'flow1', name: 'Tick', x: 100, y: 80, wires: [['n2']] },
          { id: 'n2', type: 'function', z: 'flow1', func: 'return msg;', x: 300, y: 80, g: 'g1' },
          { id: 'n3', type: 'debug', z: 'flow1', x: 500, y: 80, wires: [[]] },
        ],
        configs: [{ id: 'c1', type: 'mqtt-broker', z: 'flow1', name: 'Broker', keepalive: 60 }],
      };

      beforeEach(() => {
        vi.mocked(mockClient.getFlow).mockResolvedValue(selectionFlow);
      });

      it('should return the full flow when no option is given', async () => {
        const result = await getFlow(mockClient, { flowId: 'flow1' });

        expect(JSON.parse(result.content[0].text)).toEqual(selectionFlow);
      });

      it('should keep only the nodes named by nodeIds', async () => {
        const result = await getFlow(mockClient, { flowId: 'flow1', nodeIds: ['n2', 'c1'] });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.nodes).toEqual([selectionFlow.nodes[1]]);
        expect(parsed.configs).toEqual(selectionFlow.configs);
        expect(parsed.totalNodes).toBe(3);
        expect(parsed.totalConfigs).toBe(1);
      });

      it('should keep only the nodes of the given types', async () => {
        const result = await getFlow(mockClient, { flowId: 'flow1', types: ['debug'] });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.nodes).toEqual([selectionFlow.nodes[2]]);
        expect(parsed.configs).toEqual([]);
      });

      it('should keep a node matched by either filter', async () => {
        const result = await getFlow(mockClient, {
          flowId: 'flow1',
          nodeIds: ['n1'],
          types: ['debug'],
        });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.nodes.map((n: { id: string }) => n.id)).toEqual(['n1', 'n3']);
      });

      it('should reduce nodes to structure with summary', async () => {
        const result = await getFlow(mockClient, { flowId: 'flow1', summary: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed).toEqual({
          id: 'flow1',
          label: 'My Flow',
          disabled: false,
          info: 'Notes',
          nodes: [
            { id: 'n1', type: 'inject', name: 'Tick', wires: [['n2']] },
            { id: 'n2', type: 'function', g: 'g1' },
            { id: 'n3', type: 'debug' },
          ],
          configs: [{ id: 'c1', type: 'mqtt-broker', name: 'Broker' }],
        });
      });

      it('should not report totals when nothing is filtered out', async () => {
        const result = await getFlow(mockClient, { flowId: 'flow1', summary: true });
        const parsed = JSON.parse(result.content[0].text);

        expect(parsed.totalNodes).toBeUndefined();
        expect(parsed.totalConfigs).toBeUndefined();
      });

      it('should combine filtering and summary', async () => {
        const result = await getFlow(mockClient, {
          flowId: 'flow1',
          types: ['inject'],
          summary: true,
        });

        expect(JSON.parse(result.content[0].text)).toMatchObject({
          totalNodes: 3,
          totalConfigs: 1,
          nodes: [{ id: 'n1', type: 'inject', name: 'Tick', wires: [['n2']] }],
          configs: [],
        });
      });
    });
  });

  describe('createFlow', () => {
    it('should accept a flow without an id and report the generated one', async () => {
      vi.mocked(mockClient.createFlow).mockResolvedValue({ id: 'generated-id' });

      const result = await createFlow(mockClient, {
        flow: JSON.stringify({ label: 'New Flow', nodes: [] }),
      });

      expect(mockClient.createFlow).toHaveBeenCalledWith({ label: 'New Flow', nodes: [] });
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'generated-id' });
    });

    it('should pass an explicit id through', async () => {
      vi.mocked(mockClient.createFlow).mockResolvedValue({ id: 'flow-1' });

      await createFlow(mockClient, {
        flow: JSON.stringify({ id: 'flow-1', label: 'New Flow', nodes: [], configs: [] }),
      });

      expect(mockClient.createFlow).toHaveBeenCalledWith({
        id: 'flow-1',
        label: 'New Flow',
        nodes: [],
        configs: [],
      });
    });

    it('should throw on invalid JSON', async () => {
      await expect(createFlow(mockClient, { flow: 'not json' })).rejects.toThrow(
        'Invalid JSON in flow parameter'
      );
    });
  });

  describe('updateFlow', () => {
    it('should update flow', async () => {
      const mockResponse = { id: '1' };

      vi.mocked(mockClient.updateFlow).mockResolvedValue(mockResponse);

      const result = await updateFlow(mockClient, {
        flowId: '1',
        updates: JSON.stringify({ label: 'New Label', nodes: [] }),
      });

      expect(mockClient.updateFlow).toHaveBeenCalledWith('1', {
        id: '1',
        label: 'New Label',
        nodes: [],
      });
      expect(JSON.parse(result.content[0].text)).toEqual(mockResponse);
    });

    it('should throw error for invalid JSON updates', async () => {
      await expect(
        updateFlow(mockClient, {
          flowId: '1',
          updates: 'invalid json',
        })
      ).rejects.toThrow('Invalid JSON in updates parameter');
    });

    it('should ensure flowId matches id in updates', async () => {
      vi.mocked(mockClient.updateFlow).mockResolvedValue({ id: '1' });

      await updateFlow(mockClient, {
        flowId: '1',
        updates: JSON.stringify({ label: 'Test' }),
      });

      expect(mockClient.updateFlow).toHaveBeenCalledWith('1', expect.objectContaining({ id: '1' }));
    });

    it('should pass through subflow fields (name, in, out ports)', async () => {
      vi.mocked(mockClient.updateFlow).mockResolvedValue({ id: 'sf1' });

      const subflowData = {
        type: 'subflow',
        name: 'My Subflow',
        in: [{ wires: [{ id: 'n1', port: 0 }] }],
        out: [{ wires: [{ id: 'n2', port: 0 }] }],
        nodes: [{ id: 'n1', type: 'function', z: 'sf1' }],
      };

      await updateFlow(mockClient, {
        flowId: 'sf1',
        updates: JSON.stringify(subflowData),
      });

      expect(mockClient.updateFlow).toHaveBeenCalledWith(
        'sf1',
        expect.objectContaining({
          id: 'sf1',
          type: 'subflow',
          name: 'My Subflow',
          in: [{ wires: [{ id: 'n1', port: 0 }] }],
          out: [{ wires: [{ id: 'n2', port: 0 }] }],
        })
      );
    });
  });

  describe('deleteFlow', () => {
    it('should delete flow and return confirmation', async () => {
      vi.mocked(mockClient.deleteFlow).mockResolvedValue(undefined);

      const result = await deleteFlow(mockClient, { flowId: 'flow-1' });

      expect(mockClient.deleteFlow).toHaveBeenCalledWith('flow-1');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual({ deleted: 'flow-1' });
    });

    it('should throw error for missing flowId', async () => {
      await expect(deleteFlow(mockClient, {})).rejects.toThrow();
    });

    it('should propagate client errors', async () => {
      vi.mocked(mockClient.deleteFlow).mockRejectedValue(
        new Error('Failed to delete flow: 404\nNot Found')
      );

      await expect(deleteFlow(mockClient, { flowId: 'nonexistent' })).rejects.toThrow(
        'Failed to delete flow: 404'
      );
    });
  });

  describe('validateFlow', () => {
    const nodeSet = (name: string, types: string[]) => ({
      id: `node-red/${name}`,
      name,
      types,
      enabled: true,
      module: 'node-red',
      version: '5.0.6',
    });

    const installed = (
      sets: unknown[] = [nodeSet('inject', ['inject']), nodeSet('debug', ['debug'])]
    ) => {
      vi.mocked(mockClient.getNodes).mockResolvedValue(sets as any);
      vi.mocked(mockClient.getGlobalFlow).mockResolvedValue({
        id: 'global',
        subflows: [{ id: 'sf1', type: 'subflow', name: 'Sub', nodes: [] }],
      } as any);
    };

    const validate = async (flow: unknown) => {
      const result = await validateFlow(mockClient, { flow });
      return JSON.parse(result.content[0].text) as { valid: boolean; errors?: string[] };
    };

    it('should accept a flow whose nodes, wires and types all resolve', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        label: 'Test',
        nodes: [
          { id: 'n1', type: 'inject', z: 'f1', wires: [['n2']] },
          { id: 'n2', type: 'debug', z: 'f1' },
        ],
      });

      expect(parsed).toEqual({ valid: true });
      expect(mockClient.getNodes).toHaveBeenCalledWith({ cached: true });
      expect(mockClient.getNodes).toHaveBeenCalledTimes(1);
    });

    it('should accept a create payload that has no id yet', async () => {
      installed();

      await expect(
        validate({ label: 'New', nodes: [{ id: 'n1', type: 'inject' }] })
      ).resolves.toEqual({ valid: true });
    });

    it('should report a node or config node without id or type', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [
          { id: '', type: 'inject' },
          { id: 'n2', type: '' },
        ],
        configs: [
          { id: '', type: 'mqtt-broker' },
          { id: 'c2', type: '' },
        ],
      });

      expect(parsed.valid).toBe(false);
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          'Node missing required id field',
          'Node n2 missing required type field',
          'Config node missing required id field',
          'Config node c2 missing required type field',
        ])
      );
    });

    it('should report a duplicate id once', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [
          { id: 'n1', type: 'inject' },
          { id: 'n1', type: 'inject' },
          { id: 'n1', type: 'inject' },
        ],
      });

      expect(parsed.errors).toEqual(['Duplicate id "n1" in the flow']);
    });

    it('should report a node that reuses the flow id', async () => {
      installed();

      const parsed = await validate({ id: 'f1', nodes: [{ id: 'f1', type: 'inject' }] });

      expect(parsed.errors).toEqual(['Node "f1" uses the id of the flow itself']);
    });

    it('should report a wire to a node that is not in the flow', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [{ id: 'n1', type: 'inject', wires: [['n2'], ['n3']] }],
      });

      expect(parsed.errors).toEqual([
        'Node "n1" wires to unknown node "n2"',
        'Node "n1" wires to unknown node "n3"',
      ]);
    });

    it('should report a z that names another flow', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [{ id: 'n1', type: 'inject', z: 'f2' }],
        configs: [{ id: 'c1', type: 'inject', z: 'f1' }],
      });

      expect(parsed.errors).toEqual(['Node "n1" has z "f2" but belongs to flow "f1"']);
    });

    it('should report a group reference that does not resolve', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [
          { id: 'n1', type: 'inject', g: 'g1' },
          { id: 'g2', type: 'group', nodes: ['n1', 'gone'] },
        ],
      });

      expect(parsed.errors).toEqual([
        'Node "n1" is in group "g1", which is not a group in the flow',
        'Group "g2" lists unknown node "gone"',
      ]);
    });

    it('should accept a group, a subflow instance and a node the group contains', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [
          { id: 'g1', type: 'group', nodes: ['n1'] },
          { id: 'n1', type: 'inject', g: 'g1' },
          { id: 'n2', type: 'subflow:sf1' },
        ],
      });

      expect(parsed).toEqual({ valid: true });
    });

    it('should report a type no installed node set registers', async () => {
      installed();

      const parsed = await validate({
        id: 'f1',
        nodes: [
          { id: 'n1', type: 'foo bar' },
          { id: 'n2', type: 'subflow:missing' },
        ],
      });

      expect(parsed.errors).toEqual([
        'Node "n1" has type "foo bar" which is not installed',
        'Node "n2" has type "subflow:missing" which is not installed',
      ]);
    });

    it('should look past the cached node sets before reporting a type as missing', async () => {
      vi.mocked(mockClient.getGlobalFlow).mockResolvedValue({ id: 'global' } as any);
      vi.mocked(mockClient.getNodes)
        .mockResolvedValueOnce([] as any)
        .mockResolvedValueOnce([nodeSet('inject', ['inject'])] as any);

      const parsed = await validate({ id: 'f1', nodes: [{ id: 'n1', type: 'inject' }] });

      expect(parsed).toEqual({ valid: true });
      expect(mockClient.getNodes).toHaveBeenNthCalledWith(1, { cached: true });
      expect(mockClient.getNodes).toHaveBeenNthCalledWith(2);
    });

    it('should not ask Node-RED about a flow with no nodes', async () => {
      const parsed = await validate({ id: 'f1', label: 'Empty' });

      expect(parsed).toEqual({ valid: true });
      expect(mockClient.getNodes).not.toHaveBeenCalled();
      expect(mockClient.getGlobalFlow).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON gracefully', async () => {
      const result = await validateFlow(mockClient, { flow: 'invalid json' });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.valid).toBe(false);
      expect(parsed.errors[0]).toContain('Invalid JSON');
    });
  });

  describe('getFlowState', () => {
    it('should return flow state', async () => {
      vi.mocked(mockClient.getFlowState).mockResolvedValue({ state: 'start' });

      const result = await getFlowState(mockClient);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.state).toBe('start');
    });

    it('should return stopped state', async () => {
      vi.mocked(mockClient.getFlowState).mockResolvedValue({ state: 'stop' });

      const result = await getFlowState(mockClient);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.state).toBe('stop');
    });
  });

  describe('setFlowState', () => {
    it('should set state to stop', async () => {
      vi.mocked(mockClient.setFlowState).mockResolvedValue({ state: 'stop' });

      const result = await setFlowState(mockClient, { state: 'stop' });

      expect(mockClient.setFlowState).toHaveBeenCalledWith('stop');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.state).toBe('stop');
    });

    it('should set state to start', async () => {
      vi.mocked(mockClient.setFlowState).mockResolvedValue({ state: 'start' });

      const result = await setFlowState(mockClient, { state: 'start' });

      expect(mockClient.setFlowState).toHaveBeenCalledWith('start');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.state).toBe('start');
    });

    it('should throw error for invalid state', async () => {
      await expect(setFlowState(mockClient, { state: 'invalid' })).rejects.toThrow();
    });

    it('should throw error when state is missing', async () => {
      await expect(setFlowState(mockClient, {})).rejects.toThrow();
    });
  });

  describe('getNodes', () => {
    const nodeSet = (overrides: Record<string, unknown>) => ({
      enabled: true,
      local: false,
      user: false,
      version: '5.0.6',
      ...overrides,
    });

    it('should group node sets per module', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        nodeSet({ id: 'node-red/inject', name: 'inject', types: ['inject'], module: 'node-red' }),
        nodeSet({
          id: 'node-red/link',
          name: 'link',
          types: ['link in', 'link out', 'link call'],
          module: 'node-red',
        }),
        nodeSet({
          id: 'node-red-contrib-foo/foo',
          name: 'foo',
          types: ['foo'],
          module: 'node-red-contrib-foo',
          version: '1.0.0',
          local: true,
          user: true,
        }),
      ] as any);

      const result = await getNodes(mockClient);

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          module: 'node-red',
          version: '5.0.6',
          local: false,
          user: false,
          enabled: true,
          sets: { inject: ['inject'], link: ['link in', 'link out', 'link call'] },
        },
        {
          module: 'node-red-contrib-foo',
          version: '1.0.0',
          local: true,
          user: true,
          enabled: true,
          sets: { foo: ['foo'] },
        },
      ]);
    });

    it('should de-duplicate the types a node set registers', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        nodeSet({
          id: 'node-red/switch',
          name: 'switch',
          types: ['switch', 'switch', 'switch'],
          module: 'node-red',
        }),
      ] as any);

      const result = await getNodes(mockClient);

      expect(JSON.parse(result.content[0].text)[0].sets).toEqual({ switch: ['switch'] });
    });

    it('should name the disabled sets when a module is only partly enabled', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        nodeSet({ id: 'm/one', name: 'one', types: ['one'], module: 'm' }),
        nodeSet({ id: 'm/two', name: 'two', types: ['two'], module: 'm', enabled: false }),
      ] as any);

      const result = await getNodes(mockClient);

      expect(JSON.parse(result.content[0].text)[0]).toMatchObject({
        enabled: false,
        disabledSets: ['two'],
      });
    });

    it('should report a fully disabled module without listing every set', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        nodeSet({ id: 'm/one', name: 'one', types: ['one'], module: 'm', enabled: false }),
        nodeSet({ id: 'm/two', name: 'two', types: ['two'], module: 'm', enabled: false }),
      ] as any);

      const parsed = JSON.parse((await getNodes(mockClient)).content[0].text);

      expect(parsed[0].enabled).toBe(false);
      expect(parsed[0]).not.toHaveProperty('disabledSets');
    });

    it('should fall back to the id when a set carries no module', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        { id: '@scope/node-red-contrib-bar/bar', name: 'bar', types: ['bar'], enabled: true },
      ] as any);

      const result = await getNodes(mockClient);

      expect(JSON.parse(result.content[0].text)).toEqual([
        {
          module: '@scope/node-red-contrib-bar',
          enabled: true,
          sets: { bar: ['bar'] },
        },
      ]);
    });

    it('should handle empty modules list', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([]);

      const result = await getNodes(mockClient);

      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });
  });

  describe('textResult', () => {
    it('should pass a string through unchanged', () => {
      expect(textResult('plain text').content[0].text).toBe('plain text');
    });

    it('should serialise anything else as compact JSON', () => {
      expect(textResult({ id: 'f1', nodes: [{ id: 'n1' }] }).content[0].text).toBe(
        '{"id":"f1","nodes":[{"id":"n1"}]}'
      );
    });
  });

  describe('installNode', () => {
    it('should install node module', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: {},
      };

      vi.mocked(mockClient.installNode).mockResolvedValue(mockModule);

      const result = await installNode(mockClient, { module: 'node-red-contrib-example' });

      expect(mockClient.installNode).toHaveBeenCalledWith('node-red-contrib-example');
      expect(JSON.parse(result.content[0].text)).toEqual(mockModule);
    });

    it('should throw on missing module argument', async () => {
      await expect(installNode(mockClient, {})).rejects.toThrow();
    });
  });

  describe('setNodeModuleState', () => {
    it('should enable a module', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: {},
      };

      vi.mocked(mockClient.setNodeModuleState).mockResolvedValue(mockModule);

      const result = await setNodeModuleState(mockClient, {
        module: 'node-red-contrib-example',
        enabled: true,
      });

      expect(mockClient.setNodeModuleState).toHaveBeenCalledWith('node-red-contrib-example', true);
      expect(JSON.parse(result.content[0].text)).toEqual(mockModule);
    });

    it('should disable a module', async () => {
      const mockModule = {
        name: 'node-red-contrib-example',
        version: '1.0.0',
        nodes: {},
      };

      vi.mocked(mockClient.setNodeModuleState).mockResolvedValue(mockModule);

      const result = await setNodeModuleState(mockClient, {
        module: 'node-red-contrib-example',
        enabled: false,
      });

      expect(mockClient.setNodeModuleState).toHaveBeenCalledWith('node-red-contrib-example', false);
      expect(JSON.parse(result.content[0].text)).toEqual(mockModule);
    });

    it('should throw on missing module argument', async () => {
      await expect(setNodeModuleState(mockClient, { enabled: true })).rejects.toThrow();
    });

    it('should throw on missing enabled argument', async () => {
      await expect(
        setNodeModuleState(mockClient, { module: 'node-red-contrib-example' })
      ).rejects.toThrow();
    });
  });

  describe('getContext', () => {
    it('should get global context', async () => {
      const mockData = { key1: 'value1' };
      vi.mocked(mockClient.getContext).mockResolvedValue(mockData);
      const result = await getContext(mockClient, { scope: 'global' });
      expect(mockClient.getContext).toHaveBeenCalledWith('global', undefined, undefined, undefined);
      expect(JSON.parse(result.content[0].text)).toEqual(mockData);
    });

    it('should get global context with key', async () => {
      vi.mocked(mockClient.getContext).mockResolvedValue({ value: 'test' });
      await getContext(mockClient, { scope: 'global', key: 'myKey' });
      expect(mockClient.getContext).toHaveBeenCalledWith('global', undefined, 'myKey', undefined);
    });

    it('should get flow context with id', async () => {
      vi.mocked(mockClient.getContext).mockResolvedValue({});
      await getContext(mockClient, { scope: 'flow', id: 'flow-1' });
      expect(mockClient.getContext).toHaveBeenCalledWith('flow', 'flow-1', undefined, undefined);
    });

    it('should get node context with id and key', async () => {
      vi.mocked(mockClient.getContext).mockResolvedValue({ count: 5 });
      await getContext(mockClient, { scope: 'node', id: 'node-1', key: 'count' });
      expect(mockClient.getContext).toHaveBeenCalledWith('node', 'node-1', 'count', undefined);
    });

    it('should pass store parameter', async () => {
      vi.mocked(mockClient.getContext).mockResolvedValue({});
      await getContext(mockClient, { scope: 'global', key: 'myKey', store: 'file' });
      expect(mockClient.getContext).toHaveBeenCalledWith('global', undefined, 'myKey', 'file');
    });

    it('should throw error when flow scope missing id', async () => {
      await expect(getContext(mockClient, { scope: 'flow' })).rejects.toThrow(
        'id is required when scope is "flow"'
      );
    });

    it('should throw error when node scope missing id', async () => {
      await expect(getContext(mockClient, { scope: 'node' })).rejects.toThrow(
        'id is required when scope is "node"'
      );
    });

    it('should throw error for invalid scope', async () => {
      await expect(getContext(mockClient, { scope: 'invalid' })).rejects.toThrow();
    });
  });

  describe('deleteContext', () => {
    it('should delete global context key', async () => {
      vi.mocked(mockClient.deleteContext).mockResolvedValue(undefined);
      const result = await deleteContext(mockClient, { scope: 'global', key: 'myKey' });
      expect(mockClient.deleteContext).toHaveBeenCalledWith(
        'global',
        undefined,
        'myKey',
        undefined
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('myKey');
    });

    it('should delete flow context key', async () => {
      vi.mocked(mockClient.deleteContext).mockResolvedValue(undefined);
      await deleteContext(mockClient, { scope: 'flow', id: 'flow-1', key: 'counter' });
      expect(mockClient.deleteContext).toHaveBeenCalledWith('flow', 'flow-1', 'counter', undefined);
    });

    it('should delete node context key', async () => {
      vi.mocked(mockClient.deleteContext).mockResolvedValue(undefined);
      await deleteContext(mockClient, { scope: 'node', id: 'node-1', key: 'data' });
      expect(mockClient.deleteContext).toHaveBeenCalledWith('node', 'node-1', 'data', undefined);
    });

    it('should pass store parameter on delete', async () => {
      vi.mocked(mockClient.deleteContext).mockResolvedValue(undefined);
      await deleteContext(mockClient, { scope: 'global', key: 'myKey', store: 'file' });
      expect(mockClient.deleteContext).toHaveBeenCalledWith('global', undefined, 'myKey', 'file');
    });

    it('should throw error when flow scope missing id', async () => {
      await expect(deleteContext(mockClient, { scope: 'flow', key: 'counter' })).rejects.toThrow(
        'id is required when scope is "flow"'
      );
    });

    it('should throw error when node scope missing id', async () => {
      await expect(deleteContext(mockClient, { scope: 'node', key: 'data' })).rejects.toThrow(
        'id is required when scope is "node"'
      );
    });

    it('should throw error when key is missing', async () => {
      await expect(deleteContext(mockClient, { scope: 'global' })).rejects.toThrow();
    });
  });

  describe('removeNodeModule', () => {
    it('should remove node module', async () => {
      vi.mocked(mockClient.removeNodeModule).mockResolvedValue(undefined);

      const result = await removeNodeModule(mockClient, { module: 'node-red-contrib-example' });

      expect(mockClient.removeNodeModule).toHaveBeenCalledWith('node-red-contrib-example');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.module).toBe('node-red-contrib-example');
    });

    it('should throw on missing module argument', async () => {
      await expect(removeNodeModule(mockClient, {})).rejects.toThrow();
    });
  });

  describe('triggerInject', () => {
    it('should trigger inject node and return confirmation', async () => {
      vi.mocked(mockClient.triggerInject).mockResolvedValue(undefined);

      const result = await triggerInject(mockClient, { nodeId: 'inject-1' });

      expect(mockClient.triggerInject).toHaveBeenCalledWith('inject-1');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ nodeId: 'inject-1', triggered: true });
    });

    it('should throw on missing nodeId', async () => {
      await expect(triggerInject(mockClient, {})).rejects.toThrow();
    });

    it('should propagate client errors', async () => {
      vi.mocked(mockClient.triggerInject).mockRejectedValue(
        new Error('Failed to trigger inject node: 404\nNot Found')
      );

      await expect(triggerInject(mockClient, { nodeId: 'nonexistent' })).rejects.toThrow(
        'Failed to trigger inject node: 404'
      );
    });
  });

  describe('setDebugState', () => {
    it('should enable debug node and return confirmation', async () => {
      vi.mocked(mockClient.setDebugNodeState).mockResolvedValue(undefined);

      const result = await setDebugState(mockClient, { nodeId: 'debug-1', enabled: true });

      expect(mockClient.setDebugNodeState).toHaveBeenCalledWith('debug-1', true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ nodeId: 'debug-1', enabled: true });
    });

    it('should disable debug node', async () => {
      vi.mocked(mockClient.setDebugNodeState).mockResolvedValue(undefined);

      const result = await setDebugState(mockClient, { nodeId: 'debug-1', enabled: false });

      expect(mockClient.setDebugNodeState).toHaveBeenCalledWith('debug-1', false);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({ nodeId: 'debug-1', enabled: false });
    });

    it('should throw on missing nodeId', async () => {
      await expect(setDebugState(mockClient, { enabled: true })).rejects.toThrow();
    });

    it('should throw on missing enabled', async () => {
      await expect(setDebugState(mockClient, { nodeId: 'debug-1' })).rejects.toThrow();
    });

    it('should propagate client errors', async () => {
      vi.mocked(mockClient.setDebugNodeState).mockRejectedValue(
        new Error('Failed to enable debug node: 404\nNot Found')
      );

      await expect(
        setDebugState(mockClient, { nodeId: 'nonexistent', enabled: true })
      ).rejects.toThrow('Failed to enable debug node: 404');
    });
  });

  describe('getSubflows', () => {
    it('should return subflows array from global flow', async () => {
      const mockGlobal = {
        id: 'global',
        configs: [],
        subflows: [{ id: 'sf1', type: 'subflow', name: 'My Subflow', in: [], out: [], nodes: [] }],
      };
      vi.mocked(mockClient.getGlobalFlow).mockResolvedValue(mockGlobal as any);

      const result = await getSubflows(mockClient);
      expect(JSON.parse(result.content[0].text)).toEqual(mockGlobal.subflows);
    });

    it('should return empty array when no subflows', async () => {
      vi.mocked(mockClient.getGlobalFlow).mockResolvedValue({ id: 'global' } as any);

      const result = await getSubflows(mockClient);
      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });
  });

  describe('createSubflow', () => {
    const tab = { id: 'tab1', type: 'tab', label: 'Flow 1' };

    it('should append the definition and its contents as flat items', async () => {
      givenFlows([tab]);

      const result = await createSubflow(mockClient, {
        subflow: JSON.stringify({
          id: 'sf1',
          type: 'subflow',
          name: 'My Subflow',
          nodes: [{ id: 'n1', type: 'function', x: 10, y: 20 }],
          configs: [{ id: 'c1', type: 'mqtt-broker' }],
        }),
      });

      expect(postedFlows()).toEqual([
        tab,
        { id: 'sf1', type: 'subflow', name: 'My Subflow' },
        { id: 'n1', type: 'function', x: 10, y: 20, z: 'sf1' },
        { id: 'c1', type: 'mqtt-broker', z: 'sf1' },
      ]);
      expect(postedRev()).toBe('rev1');
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'sf1', rev: 'rev2' });
    });

    it('should throw when subflow id already exists', async () => {
      givenFlows([{ id: 'sf1', type: 'subflow', name: 'Existing' }]);

      await expect(
        createSubflow(mockClient, {
          subflow: JSON.stringify({ id: 'sf1', type: 'subflow', name: 'Duplicate', nodes: [] }),
        })
      ).rejects.toThrow('already exists');
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should throw when an inner node reuses an id from another flow', async () => {
      givenFlows([tab, { id: 'n1', type: 'inject', z: 'tab1', x: 1, y: 2 }]);

      await expect(
        createSubflow(mockClient, {
          subflow: JSON.stringify({
            id: 'sf1',
            type: 'subflow',
            name: 'My Subflow',
            nodes: [{ id: 'n1', type: 'function', x: 10, y: 20 }],
          }),
        })
      ).rejects.toThrow('Node with id "n1" already exists in the configuration');
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should throw on invalid JSON', async () => {
      await expect(createSubflow(mockClient, { subflow: 'not json' })).rejects.toThrow(
        'Invalid JSON'
      );
    });
  });

  describe('updateSubflow', () => {
    const definition = { id: 'sf1', type: 'subflow', name: 'Old Name' };
    const innerNode = { id: 'n1', type: 'function', z: 'sf1', x: 10, y: 20 };
    const innerConfig = { id: 'c1', type: 'mqtt-broker', z: 'sf1' };
    const otherNode = { id: 'n2', type: 'inject', z: 'tab1', x: 1, y: 2 };

    it('should merge the update and leave the contents alone', async () => {
      givenFlows([definition, innerNode, innerConfig, otherNode]);

      const result = await updateSubflow(mockClient, {
        subflowId: 'sf1',
        updates: JSON.stringify({ name: 'New Name' }),
      });

      expect(postedFlows()).toEqual([
        { id: 'sf1', type: 'subflow', name: 'New Name' },
        innerNode,
        innerConfig,
        otherNode,
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'sf1', rev: 'rev2' });
    });

    it('should replace the inner nodes when the update sends them', async () => {
      givenFlows([definition, innerNode, innerConfig, otherNode]);

      await updateSubflow(mockClient, {
        subflowId: 'sf1',
        updates: JSON.stringify({ nodes: [{ id: 'n3', type: 'delay', x: 30, y: 40 }] }),
      });

      expect(postedFlows()).toEqual([
        definition,
        innerConfig,
        otherNode,
        { id: 'n3', type: 'delay', x: 30, y: 40, z: 'sf1' },
      ]);
    });

    it('should replace the inner config nodes when the update sends them', async () => {
      givenFlows([definition, innerNode, innerConfig]);

      await updateSubflow(mockClient, {
        subflowId: 'sf1',
        updates: JSON.stringify({ configs: [{ id: 'c2', type: 'mqtt-broker' }] }),
      });

      expect(postedFlows()).toEqual([
        definition,
        innerNode,
        { id: 'c2', type: 'mqtt-broker', z: 'sf1' },
      ]);
    });

    it('should empty the contents when the update sends an empty list', async () => {
      givenFlows([definition, innerNode, innerConfig]);

      await updateSubflow(mockClient, {
        subflowId: 'sf1',
        updates: JSON.stringify({ nodes: [], configs: [] }),
      });

      expect(postedFlows()).toEqual([definition]);
    });

    it('should throw when subflow not found', async () => {
      givenFlows([{ id: 'tab1', type: 'tab', label: 'Flow 1' }]);

      await expect(
        updateSubflow(mockClient, { subflowId: 'missing', updates: JSON.stringify({ name: 'X' }) })
      ).rejects.toThrow('not found');
    });

    it('should reject an update that would break the subflow definition', async () => {
      givenFlows([definition]);

      await expect(
        updateSubflow(mockClient, { subflowId: 'sf1', updates: JSON.stringify({ name: 42 }) })
      ).rejects.toThrow();
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should not let an update change id or type', async () => {
      givenFlows([definition]);

      await updateSubflow(mockClient, {
        subflowId: 'sf1',
        updates: JSON.stringify({ id: 'other', type: 'tab', name: 'New Name' }),
      });

      expect(postedFlows()).toEqual([{ id: 'sf1', type: 'subflow', name: 'New Name' }]);
    });
  });

  describe('deleteSubflow', () => {
    const definition = { id: 'sf1', type: 'subflow', name: 'My Subflow' };
    const tab = { id: 'tab1', type: 'tab', label: 'Flow 1' };

    it('should delete the definition and everything inside it', async () => {
      givenFlows([
        tab,
        definition,
        { id: 'n1', type: 'function', z: 'sf1', x: 10, y: 20 },
        { id: 'c1', type: 'mqtt-broker', z: 'sf1' },
        { id: 'n2', type: 'inject', z: 'tab1', x: 1, y: 2 },
      ]);

      const result = await deleteSubflow(mockClient, { subflowId: 'sf1' });

      expect(postedFlows()).toEqual([tab, { id: 'n2', type: 'inject', z: 'tab1', x: 1, y: 2 }]);
      expect(JSON.parse(result.content[0].text)).toEqual({ deleted: 'sf1', rev: 'rev2' });
    });

    it('should throw when subflow not found', async () => {
      givenFlows([tab]);

      await expect(deleteSubflow(mockClient, { subflowId: 'missing' })).rejects.toThrow(
        'not found'
      );
    });

    it('should refuse to delete a subflow that still has instances', async () => {
      givenFlows([tab, definition, { id: 'n1', type: 'subflow:sf1', z: 'tab1', x: 1, y: 2 }]);

      await expect(deleteSubflow(mockClient, { subflowId: 'sf1' })).rejects.toThrow(
        'still used by 1 instance node(s) (n1)'
      );
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });
  });

  describe('createGlobalConfigNode', () => {
    const tab = { id: 'tab1', type: 'tab', label: 'Flow 1' };

    it('should append the node to the configuration', async () => {
      givenFlows([tab]);

      const result = await createGlobalConfigNode(mockClient, {
        node: JSON.stringify({ id: 'cfg1', type: 'mqtt-broker', name: 'My Broker' }),
      });

      expect(postedFlows()).toEqual([tab, { id: 'cfg1', type: 'mqtt-broker', name: 'My Broker' }]);
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'cfg1', rev: 'rev2' });
    });

    it('should throw when the id is taken anywhere in the configuration', async () => {
      givenFlows([{ id: 'cfg1', type: 'inject', z: 'tab1', x: 1, y: 2 }]);

      await expect(
        createGlobalConfigNode(mockClient, {
          node: JSON.stringify({ id: 'cfg1', type: 'mqtt-broker' }),
        })
      ).rejects.toThrow('already exists');
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should throw when node has a z property', async () => {
      await expect(
        createGlobalConfigNode(mockClient, {
          node: JSON.stringify({ id: 'cfg1', type: 'mqtt-broker', z: 'tab1' }),
        })
      ).rejects.toThrow('z property');
    });

    it('should throw on invalid JSON', async () => {
      await expect(createGlobalConfigNode(mockClient, { node: 'not json' })).rejects.toThrow(
        'Invalid JSON'
      );
    });
  });

  describe('updateGlobalConfigNode', () => {
    const tab = { id: 'tab1', type: 'tab', label: 'Flow 1' };

    it('should replace the node where it stands', async () => {
      givenFlows([tab, { id: 'cfg1', type: 'mqtt-broker', name: 'Old Broker' }, tab]);

      const result = await updateGlobalConfigNode(mockClient, {
        nodeId: 'cfg1',
        node: JSON.stringify({ id: 'cfg1', type: 'mqtt-broker', name: 'New Broker' }),
      });

      expect(postedFlows()).toEqual([
        tab,
        { id: 'cfg1', type: 'mqtt-broker', name: 'New Broker' },
        tab,
      ]);
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 'cfg1', rev: 'rev2' });
    });

    it('should throw when node not found', async () => {
      givenFlows([tab]);

      await expect(
        updateGlobalConfigNode(mockClient, {
          nodeId: 'missing',
          node: JSON.stringify({ id: 'missing', type: 'mqtt-broker' }),
        })
      ).rejects.toThrow('not found');
    });

    it('should not treat a tab or a subflow definition as a global config node', async () => {
      givenFlows([tab, { id: 'sf1', type: 'subflow', name: 'My Subflow' }]);

      await expect(
        updateGlobalConfigNode(mockClient, {
          nodeId: 'sf1',
          node: JSON.stringify({ id: 'sf1', type: 'mqtt-broker' }),
        })
      ).rejects.toThrow('not found');
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should throw when replacement has a z property', async () => {
      await expect(
        updateGlobalConfigNode(mockClient, {
          nodeId: 'cfg1',
          node: JSON.stringify({ id: 'cfg1', type: 'mqtt-broker', z: 'tab1' }),
        })
      ).rejects.toThrow('z property');
    });

    it('should throw on invalid JSON', async () => {
      await expect(
        updateGlobalConfigNode(mockClient, { nodeId: 'cfg1', node: 'not json' })
      ).rejects.toThrow('Invalid JSON');
    });
  });

  describe('deleteGlobalConfigNode', () => {
    const tab = { id: 'tab1', type: 'tab', label: 'Flow 1' };

    it('should remove the node from the configuration', async () => {
      givenFlows([tab, { id: 'cfg1', type: 'mqtt-broker' }]);

      const result = await deleteGlobalConfigNode(mockClient, { nodeId: 'cfg1' });

      expect(postedFlows()).toEqual([tab]);
      expect(JSON.parse(result.content[0].text)).toEqual({ deleted: 'cfg1', rev: 'rev2' });
    });

    it('should throw when node not found', async () => {
      givenFlows([tab]);

      await expect(deleteGlobalConfigNode(mockClient, { nodeId: 'missing' })).rejects.toThrow(
        'not found'
      );
    });

    it('should throw when node is referenced by another node', async () => {
      givenFlows([
        { id: 'cfg1', type: 'mqtt-broker' },
        { id: 'node1', type: 'mqtt in', z: 'tab1', x: 1, y: 2, broker: 'cfg1' },
      ]);

      await expect(deleteGlobalConfigNode(mockClient, { nodeId: 'cfg1' })).rejects.toThrow(
        'still referenced'
      );
      expect(mockClient.setFlows).not.toHaveBeenCalled();
    });

    it('should throw when the reference is nested inside another property', async () => {
      givenFlows([
        { id: 'cfg1', type: 'mqtt-broker' },
        {
          id: 'node1',
          type: 'ui_template',
          z: 'tab1',
          x: 1,
          y: 2,
          rules: [{ property: 'broker', value: { ref: 'cfg1' } }],
        },
      ]);

      await expect(deleteGlobalConfigNode(mockClient, { nodeId: 'cfg1' })).rejects.toThrow(
        'still referenced'
      );
    });
  });

  describe('object and JSON string parameters', () => {
    const flatFlows = [
      { id: 'cfg1', type: 'mqtt-broker', name: 'Old Broker' },
      { id: 'sf1', type: 'subflow', name: 'Old Name' },
    ];

    const cases = [
      {
        name: 'create_flow',
        value: { id: 'f1', label: 'New Flow', nodes: [] },
        setup: () => {
          vi.mocked(mockClient.createFlow).mockResolvedValue({ id: 'f1' });
        },
        run: (flow: unknown) => createFlow(mockClient, { flow }),
        expectCall: () =>
          expect(mockClient.createFlow).toHaveBeenCalledWith({
            id: 'f1',
            label: 'New Flow',
            nodes: [],
          }),
      },
      {
        name: 'update_flow',
        value: { label: 'New Label', nodes: [] },
        setup: () => {
          vi.mocked(mockClient.updateFlow).mockResolvedValue({ id: 'f1' });
        },
        run: (updates: unknown) => updateFlow(mockClient, { flowId: 'f1', updates }),
        expectCall: () =>
          expect(mockClient.updateFlow).toHaveBeenCalledWith('f1', {
            id: 'f1',
            label: 'New Label',
            nodes: [],
          }),
      },
      {
        name: 'validate_flow',
        value: { id: 'f1', label: 'New Flow', nodes: [{ id: 'n1', type: 'inject' }] },
        setup: () => {
          vi.mocked(mockClient.getNodes).mockResolvedValue([
            {
              id: 'node-red/inject',
              name: 'inject',
              types: ['inject'],
              enabled: true,
              module: 'node-red',
            },
          ] as any);
          vi.mocked(mockClient.getGlobalFlow).mockResolvedValue({ id: 'global' } as any);
        },
        run: (flow: unknown) => validateFlow(mockClient, { flow }),
        expectCall: () => expect(mockClient.getNodes).toHaveBeenCalledWith({ cached: true }),
      },
      {
        name: 'create_subflow',
        value: { id: 'sf2', type: 'subflow', name: 'My Subflow', nodes: [] },
        setup: () => {
          givenFlows(flatFlows);
        },
        run: (subflow: unknown) => createSubflow(mockClient, { subflow }),
        expectCall: () =>
          expect(postedFlows()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'sf2', type: 'subflow' })])
          ),
      },
      {
        name: 'update_subflow',
        value: { name: 'New Name' },
        setup: () => {
          givenFlows(flatFlows);
        },
        run: (updates: unknown) => updateSubflow(mockClient, { subflowId: 'sf1', updates }),
        expectCall: () =>
          expect(postedFlows()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'sf1', name: 'New Name' })])
          ),
      },
      {
        name: 'create_global_config_node',
        value: { id: 'cfg2', type: 'mqtt-broker', name: 'My Broker' },
        setup: () => {
          givenFlows(flatFlows);
        },
        run: (node: unknown) => createGlobalConfigNode(mockClient, { node }),
        expectCall: () =>
          expect(postedFlows()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'cfg2' })])
          ),
      },
      {
        name: 'update_global_config_node',
        value: { id: 'cfg1', type: 'mqtt-broker', name: 'New Broker' },
        setup: () => {
          givenFlows(flatFlows);
        },
        run: (node: unknown) => updateGlobalConfigNode(mockClient, { nodeId: 'cfg1', node }),
        expectCall: () =>
          expect(postedFlows()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: 'cfg1', name: 'New Broker' })])
          ),
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.name} should accept an object`, async () => {
        testCase.setup();

        await testCase.run(testCase.value);

        testCase.expectCall();
      });

      it(`${testCase.name} should accept the equivalent JSON string`, async () => {
        testCase.setup();

        await testCase.run(JSON.stringify(testCase.value));

        testCase.expectCall();
      });

      it(`${testCase.name} should reject a number`, async () => {
        testCase.setup();

        await expect(testCase.run(42)).rejects.toThrow();
      });
    }
  });
});
