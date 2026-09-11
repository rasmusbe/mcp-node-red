import { z } from 'zod';
import type { NodeRedClient } from '../client.js';
import {
  type CreateFlowRequest,
  CreateFlowRequestSchema,
  type NodeRedConfig,
  type NodeRedNode,
  type NodeSet,
} from '../schemas.js';
import { parseJsonArgument } from './json-argument.js';
import { textResult } from './result.js';

const ValidateFlowArgsSchema = z.object({
  flow: z.union([z.record(z.unknown()), z.string()]),
});

/** A group is drawn by the editor and never registered by a node set, so it has no module. */
const GROUP_TYPE = 'group';

const SUBFLOW_TYPE_PREFIX = 'subflow:';

type FlowItem = NodeRedNode | NodeRedConfig;

function itemsOf(flow: CreateFlowRequest): FlowItem[] {
  return [...(flow.nodes ?? []), ...(flow.configs ?? [])];
}

/** Both node and config node carry unknown keys, so the ones not in the schema are read by name. */
function stringProperty(item: FlowItem, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** A group node lists the ids of its members in `nodes`. */
function memberIds(group: NodeRedNode): string[] {
  const value = (group as Record<string, unknown>).nodes;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * What Node-RED will not tell you: it accepts a wire to an id that does not exist and a node
 * whose type nothing registers, deploys them, and leaves the broken result in the editor.
 */
function structuralErrors(flow: CreateFlowRequest): string[] {
  const errors: string[] = [];
  const nodes = flow.nodes ?? [];
  const configs = flow.configs ?? [];
  const items = itemsOf(flow);

  for (const node of nodes) {
    if (!node.id) {
      errors.push('Node missing required id field');
    }
    if (!node.type) {
      errors.push(`Node ${node.id} missing required type field`);
    }
  }

  for (const config of configs) {
    if (!config.id) {
      errors.push('Config node missing required id field');
    }
    if (!config.type) {
      errors.push(`Config node ${config.id} missing required type field`);
    }
  }

  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (!item.id) {
      continue;
    }
    if (ids.has(item.id) && !duplicates.has(item.id)) {
      duplicates.add(item.id);
      errors.push(`Duplicate id "${item.id}" in the flow`);
    }
    ids.add(item.id);
  }

  if (flow.id && ids.has(flow.id)) {
    errors.push(`Node "${flow.id}" uses the id of the flow itself`);
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const port of node.wires ?? []) {
      for (const target of port) {
        if (!nodeIds.has(target)) {
          errors.push(`Node "${node.id}" wires to unknown node "${target}"`);
        }
      }
    }
  }

  if (flow.id) {
    for (const item of items) {
      const parent = stringProperty(item, 'z');
      if (parent !== undefined && parent !== flow.id) {
        errors.push(`Node "${item.id}" has z "${parent}" but belongs to flow "${flow.id}"`);
      }
    }
  }

  const groups = nodes.filter((node) => node.type === GROUP_TYPE);
  const groupIds = new Set(groups.map((group) => group.id));
  for (const item of items) {
    const group = stringProperty(item, 'g');
    if (group !== undefined && !groupIds.has(group)) {
      errors.push(`Node "${item.id}" is in group "${group}", which is not a group in the flow`);
    }
  }
  for (const group of groups) {
    for (const member of memberIds(group)) {
      if (!nodeIds.has(member)) {
        errors.push(`Group "${group.id}" lists unknown node "${member}"`);
      }
    }
  }

  return errors;
}

function registeredTypes(sets: NodeSet[]): Set<string> {
  return new Set(sets.flatMap((set) => set.types ?? []));
}

function isKnownType(type: string, registered: Set<string>, subflowIds: Set<string>): boolean {
  if (registered.has(type) || type === GROUP_TYPE) {
    return true;
  }

  return (
    type.startsWith(SUBFLOW_TYPE_PREFIX) && subflowIds.has(type.slice(SUBFLOW_TYPE_PREFIX.length))
  );
}

/**
 * Node-RED deploys a node whose type nothing registers as an "unknown" node instead of refusing
 * the request, so a typo in a type only shows up as a broken node in the editor.
 */
async function unknownTypeErrors(
  client: NodeRedClient,
  flow: CreateFlowRequest
): Promise<string[]> {
  const items = itemsOf(flow).filter((item) => item.type);
  if (items.length === 0) {
    return [];
  }

  const [sets, globalFlow] = await Promise.all([
    client.getNodes({ cached: true }),
    client.getGlobalFlow(),
  ]);
  const subflowIds = new Set((globalFlow.subflows ?? []).map((subflow) => subflow.id));

  const types = new Set(items.map((item) => item.type));
  let missing = [...types].filter((type) => !isKnownType(type, registeredTypes(sets), subflowIds));

  if (missing.length > 0) {
    // The module may have been installed from the editor after the cached list was read.
    const fresh = registeredTypes(await client.getNodes());
    missing = missing.filter((type) => !isKnownType(type, fresh, subflowIds));
  }

  const unknown = new Set(missing);
  return items
    .filter((item) => unknown.has(item.type))
    .map((item) => `Node "${item.id}" has type "${item.type}" which is not installed`);
}

export async function validateFlow(client: NodeRedClient, args: unknown) {
  const parsed = ValidateFlowArgsSchema.parse(args);

  let flowData: unknown;
  try {
    flowData = parseJsonArgument(parsed.flow, 'flow');
  } catch (error) {
    // A flow that will not parse is an invalid flow, which is the answer this tool exists to
    // give, so report it instead of failing the call.
    return textResult({
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }

  // Ids are optional here because a create_flow payload has none yet.
  const flow = CreateFlowRequestSchema.parse(flowData);
  const errors = [...structuralErrors(flow), ...(await unknownTypeErrors(client, flow))];

  return textResult({
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  });
}
