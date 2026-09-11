import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { NodeRedNodeSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const CreateGlobalConfigNodeArgsSchema = z.object({
  node: z.union([z.record(z.unknown()), z.string()]),
});

export async function createGlobalConfigNode(client: NodeRedClient, args: unknown) {
  const parsed = CreateGlobalConfigNodeArgsSchema.parse(args);

  const nodeData = parseJsonArgument(parsed.node, 'node');

  const validated = NodeRedNodeSchema.parse(nodeData);

  if (validated.z !== undefined) {
    throw new Error(
      'Global config nodes must not have a z property. Flow-scoped config nodes are managed by the flow tools'
    );
  }

  const globalFlow = await client.getGlobalFlow();
  const configs = globalFlow.configs ?? [];

  if (configs.some((c) => c.id === validated.id)) {
    throw new Error(`Node with id "${validated.id}" already exists`);
  }

  await client.updateGlobalFlow({ ...globalFlow, configs: [...configs, validated] });

  return textResult({ id: validated.id });
}
