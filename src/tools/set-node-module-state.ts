import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const SetNodeModuleStateArgsSchema = z.object({
  module: z.string(),
  enabled: z.boolean(),
});

export async function setNodeModuleState(client: NodeRedClient, args: unknown) {
  const parsed = SetNodeModuleStateArgsSchema.parse(args);
  const result = await client.setNodeModuleState(parsed.module, parsed.enabled);
  return textResult(result);
}
