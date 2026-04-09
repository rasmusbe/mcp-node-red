import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedNodeSchema } from '../schemas.js';

const CreateGlobalConfigNodeArgsSchema = z.object({
  node: z.string(),
});

export async function createGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = CreateGlobalConfigNodeArgsSchema.parse(args);

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
      'Global config nodes must not have a z property — flow-scoped config nodes are managed by the flow tools'
    );
  }

  const globalFlow = await client.getGlobalFlow();
  const configs = globalFlow.configs ?? [];

  if (configs.some((c) => c.id === validated.id)) {
    throw new Error(`Node with id "${validated.id}" already exists`);
  }

  await client.updateGlobalFlow({ ...globalFlow, configs: [...configs, validated] });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ id: validated.id }, null, 2),
      },
    ],
  };
}
