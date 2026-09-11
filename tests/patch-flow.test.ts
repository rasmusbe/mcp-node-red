import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRedClient } from '../src/client.js';
import { patchFlow } from '../src/tools/patch-flow.js';

describe('patchFlow', () => {
  let mockClient: NodeRedClient;

  const flow = () => ({
    id: 'flow1',
    label: 'My Flow',
    nodes: [
      { id: 'n1', type: 'inject', z: 'flow1', name: 'Tick', x: 100, y: 80, wires: [['n2']] },
      { id: 'n2', type: 'function', z: 'flow1', func: 'return msg;', g: 'g1', wires: [['n3']] },
      { id: 'n3', type: 'debug', z: 'flow1', g: 'g1', wires: [[]] },
      { id: 'g1', type: 'group', z: 'flow1', nodes: ['n2', 'n3'] },
    ],
    configs: [{ id: 'c1', type: 'mqtt-broker', z: 'flow1', name: 'Broker' }],
  });

  const written = () => vi.mocked(mockClient.updateFlow).mock.calls[0][1] as any;

  beforeEach(() => {
    mockClient = {
      getFlow: vi.fn().mockResolvedValue(flow()),
      updateFlow: vi.fn().mockResolvedValue({ id: 'flow1' }),
    } as any;
  });

  it('should remove a node and clean up wires and group membership', async () => {
    const result = await patchFlow(mockClient, { flowId: 'flow1', removeNodeIds: ['n2'] });

    const body = written();
    expect(body.nodes.map((n: any) => n.id)).toEqual(['n1', 'n3', 'g1']);
    expect(body.nodes.find((n: any) => n.id === 'n1').wires).toEqual([[]]);
    expect(body.nodes.find((n: any) => n.id === 'g1').nodes).toEqual(['n3']);
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: 'flow1',
      removed: 1,
      updated: 0,
      added: 0,
      nodes: 3,
      configs: 1,
    });
  });

  it('should keep the key order Node-RED sent for untouched nodes', async () => {
    // A parsed copy of the flow would emit the keys the schema declares first, so every node in
    // the tab would come back to flows.json reordered for a one node change.
    await patchFlow(mockClient, { flowId: 'flow1', label: 'Renamed' });

    const untouched = written().nodes.find((n: any) => n.id === 'n1');
    expect(Object.keys(untouched)).toEqual(['id', 'type', 'z', 'name', 'x', 'y', 'wires']);
    expect(Object.keys(written())).toEqual(['id', 'label', 'nodes', 'configs']);
  });

  it('should drop the g property of nodes whose group was removed', async () => {
    await patchFlow(mockClient, { flowId: 'flow1', removeNodeIds: ['g1'] });

    const body = written();
    expect(body.nodes.find((n: any) => n.id === 'n2')).not.toHaveProperty('g');
    expect(body.nodes.find((n: any) => n.id === 'n3')).not.toHaveProperty('g');
  });

  it('should remove a flow-scoped config node', async () => {
    await patchFlow(mockClient, { flowId: 'flow1', removeNodeIds: ['c1'] });

    expect(written().configs).toEqual([]);
  });

  it('should merge an update and keep untouched fields', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      updateNodes: [{ id: 'n2', func: 'return null;', wires: [['n1']] }],
    });

    expect(written().nodes.find((n: any) => n.id === 'n2')).toEqual({
      id: 'n2',
      type: 'function',
      z: 'flow1',
      func: 'return null;',
      g: 'g1',
      wires: [['n1']],
    });
  });

  it('should update a flow-scoped config node', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      updateNodes: [{ id: 'c1', name: 'Other Broker' }],
    });

    expect(written().configs).toEqual([
      { id: 'c1', type: 'mqtt-broker', z: 'flow1', name: 'Other Broker' },
    ]);
  });

  it('should not let an update change id or z', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      updateNodes: [{ id: 'n1', z: 'other-flow', name: 'Renamed' }],
    });

    expect(written().nodes.find((n: any) => n.name === 'Renamed')).toMatchObject({
      id: 'n1',
      z: 'flow1',
    });
  });

  it('should append nodes and set z to the flow id', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      addNodes: [{ id: 'n4', type: 'debug' }],
      addConfigs: [{ id: 'c2', type: 'mqtt-broker' }],
    });

    const body = written();
    expect(body.nodes.at(-1)).toEqual({ id: 'n4', type: 'debug', z: 'flow1' });
    expect(body.configs.at(-1)).toEqual({ id: 'c2', type: 'mqtt-broker', z: 'flow1' });
  });

  it('should keep an explicit z on an added node', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      addNodes: [{ id: 'n4', type: 'debug', z: 'flow1' }],
    });

    expect(written().nodes.at(-1)).toEqual({ id: 'n4', type: 'debug', z: 'flow1' });
  });

  it('should throw when an added id already exists', async () => {
    await expect(
      patchFlow(mockClient, { flowId: 'flow1', addNodes: [{ id: 'n1', type: 'debug' }] })
    ).rejects.toThrow('Node with id "n1" already exists in flow "flow1"');
    expect(mockClient.updateFlow).not.toHaveBeenCalled();
  });

  it('should throw when an added id collides with a config node', async () => {
    await expect(
      patchFlow(mockClient, { flowId: 'flow1', addConfigs: [{ id: 'c1', type: 'mqtt-broker' }] })
    ).rejects.toThrow('already exists');
  });

  it('should throw when removing an unknown id', async () => {
    await expect(
      patchFlow(mockClient, { flowId: 'flow1', removeNodeIds: ['nope'] })
    ).rejects.toThrow('Node with id "nope" not found in flow "flow1"');
    expect(mockClient.updateFlow).not.toHaveBeenCalled();
  });

  it('should throw when updating an unknown id', async () => {
    await expect(
      patchFlow(mockClient, { flowId: 'flow1', updateNodes: [{ id: 'nope', name: 'X' }] })
    ).rejects.toThrow('Node with id "nope" not found in flow "flow1"');
    expect(mockClient.updateFlow).not.toHaveBeenCalled();
  });

  it('should set label, disabled and info without touching nodes', async () => {
    const result = await patchFlow(mockClient, {
      flowId: 'flow1',
      label: 'Renamed Flow',
      disabled: true,
      info: 'Notes',
    });

    const body = written();
    expect(body).toMatchObject({ label: 'Renamed Flow', disabled: true, info: 'Notes' });
    expect(body.nodes).toEqual(flow().nodes);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      removed: 0,
      updated: 0,
      added: 0,
      nodes: 4,
    });
  });

  it('should throw when no change is requested', async () => {
    await expect(patchFlow(mockClient, { flowId: 'flow1' })).rejects.toThrow(
      'No changes requested'
    );
    expect(mockClient.getFlow).not.toHaveBeenCalled();
  });

  it('should write back the full merged flow', async () => {
    await patchFlow(mockClient, {
      flowId: 'flow1',
      label: 'Renamed Flow',
      removeNodeIds: ['n3'],
      updateNodes: [{ id: 'n1', name: 'Every minute' }],
      addNodes: [{ id: 'n4', type: 'debug' }],
    });

    expect(mockClient.updateFlow).toHaveBeenCalledWith('flow1', {
      id: 'flow1',
      label: 'Renamed Flow',
      nodes: [
        {
          id: 'n1',
          type: 'inject',
          z: 'flow1',
          name: 'Every minute',
          x: 100,
          y: 80,
          wires: [['n2']],
        },
        { id: 'n2', type: 'function', z: 'flow1', func: 'return msg;', g: 'g1', wires: [[]] },
        { id: 'g1', type: 'group', z: 'flow1', nodes: ['n2'] },
        { id: 'n4', type: 'debug', z: 'flow1' },
      ],
      configs: [{ id: 'c1', type: 'mqtt-broker', z: 'flow1', name: 'Broker' }],
    });
  });

  it('should tolerate a flow without nodes or configs', async () => {
    vi.mocked(mockClient.getFlow).mockResolvedValue({ id: 'flow1', label: 'Empty' });

    await patchFlow(mockClient, { flowId: 'flow1', addNodes: [{ id: 'n1', type: 'debug' }] });

    expect(mockClient.updateFlow).toHaveBeenCalledWith('flow1', {
      id: 'flow1',
      label: 'Empty',
      nodes: [{ id: 'n1', type: 'debug', z: 'flow1' }],
      configs: [],
    });
  });

  it('should require an id on every node patch', async () => {
    await expect(
      patchFlow(mockClient, { flowId: 'flow1', updateNodes: [{ name: 'X' }] })
    ).rejects.toThrow();
  });
});
