import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function getSettings(client: NodeRedClient) {
  const result = await client.getSettings();
  return textResult(result);
}
