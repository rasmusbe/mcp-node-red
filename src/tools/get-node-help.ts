import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { type NodeArgument, extractNodeArguments, extractNodeHelp } from '../node-help.js';

const GetNodeHelpArgsSchema = z.union([
  z.object({ type: z.string(), raw: z.boolean().optional() }),
  z.object({ module: z.string(), set: z.string(), raw: z.boolean().optional() }),
]);

/**
 * GET /nodes returns one entry per node set, each carrying the types it registers and an id
 * of the form "<module>/<set>". That is enough to go from a node type seen in a flow to the
 * module and set the help endpoint wants.
 */
const NodeSetListSchema = z.array(
  z
    .object({
      id: z.string(),
      types: z.array(z.string()).optional(),
    })
    .passthrough()
);

interface NodeSetRef {
  module: string;
  set: string;
}

async function resolveType(client: NodeRedClient, type: string): Promise<NodeSetRef> {
  const sets = NodeSetListSchema.parse(await client.getNodes());
  const match = sets.find((candidate) => candidate.types?.includes(type));

  if (!match) {
    throw new Error(
      `No installed node set registers the type "${type}". Use get_nodes to see what is available.`
    );
  }

  const separator = match.id.lastIndexOf('/');
  if (separator === -1) {
    throw new Error(`Unexpected node set id "${match.id}", expected "<module>/<set>".`);
  }

  return { module: match.id.slice(0, separator), set: match.id.slice(separator + 1) };
}

function asToolResult(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

export async function getNodeHelp(client: NodeRedClient, args: unknown) {
  const parsed = GetNodeHelpArgsSchema.parse(args);
  const target =
    'type' in parsed
      ? await resolveType(client, parsed.type)
      : { module: parsed.module, set: parsed.set };

  const config = await client.getNodeConfig(target.module, target.set);

  if (parsed.raw) {
    return asToolResult(config);
  }

  // A node set can register several types, so keep only the one that was asked for when the
  // caller named a type. Fall back to every block if the filter empties the list.
  const blocks = extractNodeHelp(config);
  const requested = 'type' in parsed ? blocks.filter((b) => b.type === parsed.type) : [];
  const selected = requested.length > 0 ? requested : blocks;
  const argumentsByType = extractNodeArguments(config);

  if (selected.length === 0) {
    return asToolResult(
      `No help section found for ${target.module}/${target.set}. Raw node config HTML follows.\n\n${config}`
    );
  }

  const sections = selected.map((block) => {
    const args = argumentsByType.get(block.type) ?? [];
    return [`## ${block.type}`, '', block.help, '', renderArguments(args)].join('\n').trimEnd();
  });

  return asToolResult(sections.join('\n\n'));
}

/**
 * The properties come from the edit dialog, so they are what create_flow and update_flow can
 * actually set on the node. Rendered as a list rather than JSON to keep it readable next to the
 * help HTML above it.
 */
function renderArguments(args: NodeArgument[]): string {
  if (args.length === 0) {
    return '';
  }

  const lines = args.map((arg) => {
    const details = [arg.inputType];
    if (arg.options) details.push(`one of: ${arg.options.map((o) => `"${o}"`).join(', ')}`);
    if (arg.label) details.push(`labelled "${arg.label}"`);
    if (arg.placeholder) details.push(`example: ${arg.placeholder}`);
    if (arg.description) details.push(arg.description);
    return `- \`${arg.name}\` (${details.join('; ')})`;
  });

  return ['### Configurable properties', '', ...lines].join('\n');
}
