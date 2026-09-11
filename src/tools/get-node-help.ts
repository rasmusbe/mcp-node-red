import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import { htmlToMarkdown } from '../html-to-markdown.js';
import { type NodeDefault, type NodeDefaults, extractNodeDefaults } from '../node-defaults.js';
import { type NodeArgument, extractNodeArguments, extractNodeHelp } from '../node-help.js';
import type { NodeSet } from '../schemas.js';
import { textResult } from './result.js';

const GetNodeHelpArgsSchema = z.union([
  z.object({ type: z.string(), raw: z.boolean().optional() }),
  z.object({ module: z.string(), set: z.string(), raw: z.boolean().optional() }),
]);

interface NodeSetRef {
  module: string;
  set: string;
}

/**
 * A node set carries the types it registers and an id of the form "<module>/<set>", which is
 * what the help endpoint wants. The cached list answers this in a request-free lookup; a type
 * missing from it may be a module installed from the editor since, so ask again before giving up.
 */
async function resolveType(client: NodeRedClient, type: string): Promise<NodeSetRef> {
  const registers = (sets: NodeSet[]) => sets.find((set) => set.types?.includes(type));

  const match =
    registers(await client.getNodes({ cached: true })) ?? registers(await client.getNodes());

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

export async function getNodeHelp(client: NodeRedClient, args: unknown) {
  const parsed = GetNodeHelpArgsSchema.parse(args);
  const target =
    'type' in parsed
      ? await resolveType(client, parsed.type)
      : { module: parsed.module, set: parsed.set };

  const config = await client.getNodeConfig(target.module, target.set);

  if (parsed.raw) {
    return textResult(config);
  }

  // A node set can register several types, so keep only the one that was asked for when the
  // caller named a type. Fall back to every block if the filter empties the list.
  const blocks = extractNodeHelp(config);
  const requested = 'type' in parsed ? blocks.filter((b) => b.type === parsed.type) : [];
  const selected = requested.length > 0 ? requested : blocks;
  const argumentsByType = extractNodeArguments(config);
  const defaultsByType = extractNodeDefaults(config);

  if (selected.length === 0) {
    return textResult(
      `No help section found for ${target.module}/${target.set}. Raw node config HTML follows.\n\n${config}`
    );
  }

  const sections = selected.map((block) => {
    const help = block.format === 'markdown' ? block.help : htmlToMarkdown(block.help);
    const defaults = defaultsByType.get(block.type);
    const properties = mergeProperties(defaults, argumentsByType.get(block.type) ?? []);
    return [
      `## ${block.type}`,
      '',
      help,
      '',
      renderProperties(properties, defaults?.credentials ?? []),
    ]
      .join('\n')
      .trimEnd();
  });

  return textResult(sections.join('\n\n'));
}

/** A property as the node stores it, with whatever the edit dialog says about its field. */
interface Property extends NodeDefault {
  dialog?: NodeArgument;
}

/**
 * The `defaults` object decides which properties exist, because those are the keys Node-RED
 * writes to the flow; a field in the dialog that is not among them is not stored and a property
 * the dialog never renders still is. The dialog only adds what it knows about a field. A node
 * set whose editor JavaScript could not be read at all falls back to the dialog alone.
 */
function mergeProperties(defaults: NodeDefaults | undefined, dialog: NodeArgument[]): Property[] {
  if (!defaults) {
    return dialog.map((argument) => ({ name: argument.name, dialog: argument }));
  }

  const byName = new Map(dialog.map((argument) => [argument.name, argument]));
  return defaults.properties.map((property) => ({
    ...property,
    dialog: byName.get(property.name),
  }));
}

/**
 * Rendered as a list rather than JSON to keep it readable next to the help above it, and because
 * the caller reads this to write a node, not to parse it.
 */
function renderProperties(properties: Property[], credentials: NodeDefault[]): string {
  const sections: string[] = [];

  if (properties.length > 0) {
    sections.push(['### Properties', '', ...properties.map(propertyLine)].join('\n'));
  }
  if (credentials.length > 0) {
    sections.push(['### Credentials', '', ...credentials.map(credentialLine)].join('\n'));
  }
  return sections.join('\n\n');
}

function propertyLine(property: Property): string {
  const details: string[] = [];
  const dialog = property.dialog;

  // A property that names a config node type holds an id, whatever field the dialog draws for it.
  if (property.type) details.push(`config node "${property.type}"`);
  else if (dialog) details.push(dialog.inputType);

  if (property.required) details.push('required');
  if (dialog?.options) details.push(`one of: ${dialog.options.map((o) => `"${o}"`).join(', ')}`);
  if (dialog?.label) details.push(`labelled "${dialog.label}"`);
  if (dialog?.placeholder) details.push(`example: ${dialog.placeholder}`);
  if (dialog?.description) details.push(dialog.description);

  const value = renderDefault(property.value);
  if (value) details.push(`default ${value}`);

  return details.length > 0
    ? `- \`${property.name}\` (${details.join('; ')})`
    : `- \`${property.name}\``;
}

function credentialLine(credential: NodeDefault): string {
  const details = credential.type ? [credential.type] : [];
  details.push('set in the editor, not stored in the flow');
  return `- \`${credential.name}\` (${details.join('; ')})`;
}

/** An empty string default says nothing, and a long one is a sample rather than a value. */
function renderDefault(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return json.length > 80 ? `${json.slice(0, 80)}...` : json;
}
