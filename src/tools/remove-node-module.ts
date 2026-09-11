import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const RemoveNodeModuleArgsSchema = z.object({
  module: z.string(),
});

export async function removeNodeModule(client: NodeRedClient, args: unknown) {
  const parsed = RemoveNodeModuleArgsSchema.parse(args);
  await client.removeNodeModule(parsed.module);
  return textResult({ success: true, module: parsed.module });
}
