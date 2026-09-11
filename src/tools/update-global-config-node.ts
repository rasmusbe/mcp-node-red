import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedNodeSchema } from '../schemas.js';
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

  const globalFlow = await client.getGlobalFlow();
  const configs = globalFlow.configs ?? [];

  if (!configs.some((c) => c.id === parsed.nodeId)) {
    throw new Error(`Node with id "${parsed.nodeId}" not found`);
  }

  await client.updateGlobalFlow({
    ...globalFlow,
    configs: configs.map((c) => (c.id === parsed.nodeId ? validated : c)),
  });

  return textResult({ id: validated.id });
}
