import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { UpdateFlowRequestSchema } from '../schemas.js';
import { textResult } from './result.js';

const ValidateFlowArgsSchema = z.object({
  flow: z.string(),
});

export async function validateFlow(client: NodeRedClient, args: unknown) {
  const parsed = ValidateFlowArgsSchema.parse(args);

  let flowData: unknown;
  try {
    flowData = JSON.parse(parsed.flow);
  } catch (error) {
    return textResult({
      valid: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    });
  }

  const validated = UpdateFlowRequestSchema.parse(flowData);
  const result = await client.validateFlow(validated);

  return textResult(result);
}
