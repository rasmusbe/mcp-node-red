import type { NodeRedClient } from '../client.js';
import { textResult } from './result.js';

export async function getDiagnostics(client: NodeRedClient) {
  const result = await client.getDiagnostics();
  return textResult(result);
}
