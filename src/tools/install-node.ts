import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

const InstallNodeArgsSchema = z.object({
  module: z.string(),
});

export async function installNode(client: NodeRedClient, args: unknown) {
  const parsed = InstallNodeArgsSchema.parse(args);
  const result = await client.installNode(parsed.module);
  return textResult(result);
}
