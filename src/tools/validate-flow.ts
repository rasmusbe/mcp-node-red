import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { UpdateFlowRequestSchema } from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const ValidateFlowArgsSchema = z.object({
  flow: z.union([z.record(z.unknown()), z.string()]),
});

export async function validateFlow(client: NodeRedClient, args: unknown) {
  const parsed = ValidateFlowArgsSchema.parse(args);

  let flowData: unknown;
  try {
    flowData = parseJsonArgument(parsed.flow, 'flow');
  } catch (error) {
    // A flow that will not parse is an invalid flow, which is the answer this tool exists to
    // give, so report it instead of failing the call.
    return textResult({
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }

  const validated = UpdateFlowRequestSchema.parse(flowData);
  const result = await client.validateFlow(validated);

  return textResult(result);
}
