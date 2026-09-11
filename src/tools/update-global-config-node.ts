import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { type NodeRedItem, NodeRedNodeSchema } from '../schemas.js';
import { isGlobalConfigNode, modifyFlows } from './global-flow.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const UpdateGlobalConfigNodeArgsSchema = z.object({
  nodeId: z.string(),
  node: z.union([z.record(z.unknown()), z.string()]),
});

export async function updateGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = UpdateGlobalConfigNodeArgsSchema.parse(args);

  const nodeData = parseJsonArgument(parsed.node, 'node');

  const validated = NodeRedNodeSchema.parse(nodeData);

  if (validated.z !== undefined) {
    throw new Error(
      'Replacement node must not have a z property. Flow-scoped config nodes are managed by the flow tools'
    );
  }

  const { rev } = await modifyFlows(client, (flows) => {
    const current = flows.find((item) => item.id === parsed.nodeId && isGlobalConfigNode(item));

    if (!current) {
      throw new Error(`Node with id "${parsed.nodeId}" not found`);
    }

    // The replacement is written as the caller sent it: Zod's passthrough emits the keys it
    // declares before the rest, so the parsed copy would land in flows.json reordered.
    return flows.map((item) => (item === current ? (nodeData as NodeRedItem) : item));
  });

  return textResult({ id: validated.id, rev });
}
