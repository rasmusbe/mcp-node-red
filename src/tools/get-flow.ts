import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import type { NodeRedConfig, NodeRedNode } from '../schemas.js';
import { FlowResponseSchema } from '../schemas.js';
import { textResult } from './result.js';

const GetFlowArgsSchema = z.object({
  flowId: z.string(),
  nodeIds: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  summary: z.boolean().optional(),
});

/**
 * What is left of a node once the editor's bookkeeping is dropped: enough to see what the flow
 * does and how it is wired, without the coordinates and the per-node configuration that make up
 * most of the characters.
 */
function summarizeNode(node: NodeRedNode): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: node.id, type: node.type };

  if (node.name !== undefined) {
    summary.name = node.name;
  }
  if (typeof node.g === 'string') {
    summary.g = node.g;
  }
  if (node.wires?.some((port) => port.length > 0)) {
    summary.wires = node.wires;
  }

  return summary;
}

function summarizeConfig(config: NodeRedConfig): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: config.id, type: config.type };

  if (typeof config.name === 'string') {
    summary.name = config.name;
  }

  return summary;
}

export async function getFlow(client: NodeRedClient, args: unknown) {
  const { flowId, nodeIds, types, summary } = GetFlowArgsSchema.parse(args);
  const result = await client.getFlow(flowId);

  if (!nodeIds && !types && !summary) {
    return textResult(result);
  }

  const { nodes: allNodes, configs: allConfigs, ...flow } = FlowResponseSchema.parse(result);

  const filtering = nodeIds !== undefined || types !== undefined;
  const keep = (item: { id: string; type: string }) =>
    !filtering || nodeIds?.includes(item.id) === true || types?.includes(item.type) === true;

  const nodes = allNodes.filter(keep);
  const configs = allConfigs.filter(keep);

  return textResult({
    ...flow,
    // Without the totals a filtered read looks like a flow that happens to have three nodes.
    ...(filtering ? { totalNodes: allNodes.length, totalConfigs: allConfigs.length } : {}),
    nodes: summary ? nodes.map(summarizeNode) : nodes,
    configs: summary ? configs.map(summarizeConfig) : configs,
  });
}
