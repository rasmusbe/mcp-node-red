import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedNodeSchema } from '../schemas.js';

const UpdateGlobalConfigNodeArgsSchema = z.object({
  nodeId: z.string(),
  node: z.string(),
});

export async function updateGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = UpdateGlobalConfigNodeArgsSchema.parse(args);

  let nodeData: unknown;
  try {
    nodeData = JSON.parse(parsed.node);
  } catch (error) {
    throw new Error(
      `Invalid JSON in node parameter: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const validated = NodeRedNodeSchema.parse(nodeData);

  if (validated.z !== undefined) {
    throw new Error(
      'Replacement node must not have a z property — flow-scoped config nodes are managed by the flow tools'
    );
  }

  const globalFlow = await client.getGlobalFlow();
  const configs = globalFlow.configs ?? [];

  if (!configs.some((c) => c.id === parsed.nodeId)) {
    throw new Error(`Node with id "${parsed.nodeId}" not found`);
  }

  await client.updateGlobalFlow({
    ...globalFlow,
    configs: configs.map((c) => (c.id === parsed.nodeId ? validated : c)),
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ id: validated.id }, null, 2),
      },
    ],
  };
}
