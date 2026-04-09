import type { NodeRedClient } from '../client.js';

export async function listFlows(client: NodeRedClient) {
  const result = await client.getFlows();
  const tabs = result.flows
    .filter((item) => item.type === 'tab')
    .map((item) => ({ id: item.id, label: (item as { label?: string }).label, type: item.type }));
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(tabs, null, 2),
      },
    ],
  };
}
