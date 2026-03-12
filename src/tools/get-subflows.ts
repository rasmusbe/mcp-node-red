import type { NodeRedClient } from '../client.js';

export async function getSubflows(client: NodeRedClient) {
  const globalFlow = await client.getGlobalFlow();

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(globalFlow.subflows ?? [], null, 2),
      },
    ],
  };
}
