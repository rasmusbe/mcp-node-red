import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { CreateFlowRequestSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const CreateFlowArgsSchema = z.object({
  flow: z.union([z.record(z.unknown()), z.string()]),
});

export async function createFlow(client: NodeRedClient, args: unknown) {
  const parsed = CreateFlowArgsSchema.parse(args);

  const flowData = parseJsonArgument(parsed.flow, 'flow');
  const validated = CreateFlowRequestSchema.parse(flowData);

  const result = await client.createFlow(validated);

  return textResult(result);
}
