import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedConfig, NodeRedNode, UpdateFlowRequest } from '../schemas.js';
import {
  FlowResponseSchema,
  NodeRedConfigSchema,
  NodeRedNodeSchema,
  UpdateFlowRequestSchema,
} from '../schemas.js';
import { textResult } from './result.js';

const NodePatchSchema = z.object({ id: z.string() }).passthrough();

/** GET /flow/:id as Node-RED sent it, before any schema filled the lists in. */
interface RawFlow extends Record<string, unknown> {
  nodes?: NodeRedNode[];
  configs?: NodeRedConfig[];
}

const PatchFlowArgsSchema = z.object({
  flowId: z.string(),
  label: z.string().optional(),
  disabled: z.boolean().optional(),
  info: z.string().optional(),
  removeNodeIds: z.array(z.string()).optional(),
  updateNodes: z.array(NodePatchSchema).optional(),
  addNodes: z.array(NodeRedNodeSchema).optional(),
  addConfigs: z.array(NodeRedConfigSchema).optional(),
});

/**
 * A wire, a group membership or a group member list that points at a node which no longer
 * exists is not cleaned up by Node-RED: the editor draws the wire as broken and the group as
 * missing a member. Removals here therefore rewrite the references too.
 */
function withoutRemovedReferences(node: NodeRedNode, removed: Set<string>): NodeRedNode {
  const cleaned: Record<string, unknown> = { ...node };

  if (Array.isArray(cleaned.wires)) {
    cleaned.wires = cleaned.wires.map((port) =>
      Array.isArray(port) ? port.filter((id) => typeof id !== 'string' || !removed.has(id)) : port
    );
  }

  if (cleaned.type === 'group' && Array.isArray(cleaned.nodes)) {
    cleaned.nodes = cleaned.nodes.filter((id) => typeof id !== 'string' || !removed.has(id));
  }

  if (typeof cleaned.g === 'string' && removed.has(cleaned.g)) {
    const { g: _removedGroup, ...withoutGroup } = cleaned;
    return withoutGroup as NodeRedNode;
  }

  return cleaned as NodeRedNode;
}

export async function patchFlow(client: NodeRedClient, args: unknown) {
  const parsed = PatchFlowArgsSchema.parse(args);
  const { flowId } = parsed;

  const removeNodeIds = parsed.removeNodeIds ?? [];
  const updateNodes = parsed.updateNodes ?? [];
  const addNodes = parsed.addNodes ?? [];
  const addConfigs = parsed.addConfigs ?? [];

  const setsFlowFields =
    parsed.label !== undefined || parsed.disabled !== undefined || parsed.info !== undefined;

  if (
    !setsFlowFields &&
    removeNodeIds.length === 0 &&
    updateNodes.length === 0 &&
    addNodes.length === 0 &&
    addConfigs.length === 0
  ) {
    throw new Error(
      'No changes requested. Pass at least one of label, disabled, info, removeNodeIds, updateNodes, addNodes or addConfigs'
    );
  }

  // Validate what Node-RED sent, but keep working from the object itself: Zod's passthrough emits
  // the keys a schema declares before the rest, so a parsed copy of a node has its wires ahead of
  // its coordinates and the write would rewrite the key order of every node in the tab. Node-RED
  // omits both lists when a flow has none, and the schema's defaults no longer stand in.
  const flow = (await client.getFlow(flowId)) as RawFlow;
  FlowResponseSchema.parse(flow);
  let nodes: NodeRedNode[] = [...(flow.nodes ?? [])];
  let configs: NodeRedConfig[] = [...(flow.configs ?? [])];

  const removed = new Set<string>();
  for (const id of removeNodeIds) {
    if (!nodes.some((node) => node.id === id) && !configs.some((config) => config.id === id)) {
      throw new Error(`Node with id "${id}" not found in flow "${flowId}"`);
    }
    removed.add(id);
  }

  if (removed.size > 0) {
    nodes = nodes
      .filter((node) => !removed.has(node.id))
      .map((node) => withoutRemovedReferences(node, removed));
    configs = configs.filter((config) => !removed.has(config.id));
  }

  for (const patch of updateNodes) {
    const nodeIndex = nodes.findIndex((node) => node.id === patch.id);
    const configIndex =
      nodeIndex === -1 ? configs.findIndex((config) => config.id === patch.id) : -1;

    if (nodeIndex === -1 && configIndex === -1) {
      throw new Error(`Node with id "${patch.id}" not found in flow "${flowId}"`);
    }

    // The patch is shallow on purpose: a wires array or a rules array is replaced whole, because
    // merging arrays element by element has no meaning the caller could predict.
    if (nodeIndex !== -1) {
      nodes[nodeIndex] = { ...nodes[nodeIndex], ...patch, id: patch.id, z: flowId };
    } else {
      configs[configIndex] = { ...configs[configIndex], ...patch, id: patch.id, z: flowId };
    }
  }

  const claimId = (id: string) => {
    if (nodes.some((node) => node.id === id) || configs.some((config) => config.id === id)) {
      throw new Error(`Node with id "${id}" already exists in flow "${flowId}"`);
    }
  };

  for (const node of addNodes) {
    claimId(node.id);
    nodes.push({ ...node, z: node.z ?? flowId });
  }

  for (const config of addConfigs) {
    claimId(config.id);
    configs.push({ ...config, z: typeof config.z === 'string' ? config.z : flowId });
  }

  const merged = {
    ...flow,
    id: flowId,
    ...(parsed.label !== undefined ? { label: parsed.label } : {}),
    ...(parsed.disabled !== undefined ? { disabled: parsed.disabled } : {}),
    ...(parsed.info !== undefined ? { info: parsed.info } : {}),
    nodes,
    configs,
  } as UpdateFlowRequest;

  // PUT /flow/:id replaces the flow with what is sent, so validate the merged result rather than
  // the patch: a write that Node-RED cannot read back leaves the tab unusable in the editor. Only
  // the check is wanted here, for the same key order reason as the read above.
  UpdateFlowRequestSchema.parse(merged);

  await client.updateFlow(flowId, merged);

  return textResult({
    id: flowId,
    removed: removed.size,
    updated: updateNodes.length,
    added: addNodes.length + addConfigs.length,
    nodes: nodes.length,
    configs: configs.length,
  });
}
