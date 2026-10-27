import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { NodeRedClient } from './client.js';
import { formatZodError } from './errors.js';
import { ConfigSchema } from './schemas.js';
import { createFlow } from './tools/create-flow.js';
import { createGlobalConfigNode } from './tools/create-global-config-node.js';
import { createSubflow } from './tools/create-subflow.js';
import { deleteContext } from './tools/delete-context.js';
import { deleteFlow } from './tools/delete-flow.js';
import { deleteGlobalConfigNode } from './tools/delete-global-config-node.js';
import { deleteSubflow } from './tools/delete-subflow.js';
import { getContext } from './tools/get-context.js';
import { getDiagnostics } from './tools/get-diagnostics.js';
import { getFlowState } from './tools/get-flow-state.js';
import { getFlow } from './tools/get-flow.js';
import { getNodeHelp } from './tools/get-node-help.js';
import { getNodes } from './tools/get-nodes.js';
import { getSettings } from './tools/get-settings.js';
import { getSubflows } from './tools/get-subflows.js';
import { installNode } from './tools/install-node.js';
import { listFlows } from './tools/list-flows.js';
import { patchFlow } from './tools/patch-flow.js';
import { removeNodeModule } from './tools/remove-node-module.js';
import { textResult } from './tools/result.js';
import { setDebugState } from './tools/set-debug-state.js';
import { setFlowState } from './tools/set-flow-state.js';
import { setNodeModuleState } from './tools/set-node-module-state.js';
import { triggerInject } from './tools/trigger-inject.js';
import { updateFlow } from './tools/update-flow.js';
import { updateGlobalConfigNode } from './tools/update-global-config-node.js';
import { updateSubflow } from './tools/update-subflow.js';
import { validateFlow } from './tools/validate-flow.js';

/**
 * Report the published version rather than a second copy that drifts from package.json. A JSON
 * import will not compile with rootDir ./src, and both src/server.ts and dist/server.js sit one
 * level below the repo root, so the same relative path works for tests and for the build.
 */
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const WRITE: ToolAnnotations = { destructiveHint: false, idempotentHint: true };
const REPLACE: ToolAnnotations = { idempotentHint: true };
const DESTRUCTIVE: ToolAnnotations = {};

/**
 * Hints that let a client tell reads from writes instead of treating every tool as a write.
 * Without them the protocol default is a destructive, non-idempotent write, so only the
 * differences from that default are spelled out, which keeps the tool list small. The update
 * tools replace what they are given, so they count as destructive but idempotent; the delete and
 * remove tools fail on a second call, so they are not. patch_flow changes only the parts it is
 * told to.
 */
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  list_flows: READ_ONLY,
  get_flow: READ_ONLY,
  validate_flow: READ_ONLY,
  get_subflows: READ_ONLY,
  get_flow_state: READ_ONLY,
  get_context: READ_ONLY,
  get_nodes: READ_ONLY,
  get_node_help: READ_ONLY,
  get_settings: READ_ONLY,
  get_diagnostics: READ_ONLY,
  create_flow: { destructiveHint: false },
  create_subflow: { destructiveHint: false },
  create_global_config_node: { destructiveHint: false },
  patch_flow: { destructiveHint: false },
  set_flow_state: WRITE,
  set_node_module_state: WRITE,
  set_debug_state: WRITE,
  trigger_inject: { destructiveHint: false },
  install_node: { destructiveHint: false },
  update_flow: REPLACE,
  update_subflow: REPLACE,
  update_global_config_node: REPLACE,
  delete_flow: DESTRUCTIVE,
  delete_subflow: DESTRUCTIVE,
  delete_global_config_node: DESTRUCTIVE,
  delete_context: DESTRUCTIVE,
  remove_node_module: DESTRUCTIVE,
};

/** The client for one Node-RED instance, configured from the environment. */
export function createClient(): NodeRedClient {
  const nodeRedUrl = process.env.NODE_RED_URL;
  const nodeRedToken = process.env.NODE_RED_TOKEN;

  if (!nodeRedUrl) {
    throw new Error('NODE_RED_URL environment variable is required');
  }

  return new NodeRedClient(ConfigSchema.parse({ nodeRedUrl, nodeRedToken }));
}

/**
 * The HTTP transport builds a server per request, so it passes in a client of its own: a client
 * created here would be thrown away with the server and its node set cache with it.
 */
export function createServer(options?: { client?: NodeRedClient }) {
  const client = options?.client ?? createClient();

  const server = new Server(
    {
      name: 'node-red-mcp-server',
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_flows',
        description: 'List the flow tabs: id, label and disabled.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_flow',
        description:
          'Get a flow tab with its nodes and flow-scoped config nodes. A node is kept when either nodeIds or types matches it.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
            },
            nodeIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only these ids.',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only these node types (e.g. "mqtt in").',
            },
            summary: {
              type: 'boolean',
              description:
                'Reduce each node to id, type, name, group and wires. Not valid input for update_flow.',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'create_flow',
        description: 'Create a flow tab.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: {
              type: 'object',
              description: 'Flow object: {id?, label, nodes: [], configs: []}.',
            },
          },
          required: ['flow'],
        },
      },
      {
        name: 'update_flow',
        description:
          'Replace one flow with what is sent, leaving other flows untouched. The whole node list has to be included.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
            },
            updates: {
              type: 'object',
              description: 'Flow object: {id, label, nodes: [], configs: []}.',
            },
          },
          required: ['flowId', 'updates'],
        },
      },
      {
        name: 'patch_flow',
        description:
          'Change part of a flow without resending it. Operations run in the order remove, update, replace, add. Prefer this over update_flow. An editor deploy between its read and write is overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
            },
            label: {
              type: 'string',
            },
            disabled: {
              type: 'boolean',
            },
            info: {
              type: 'string',
              description: 'Description text for the flow tab.',
            },
            removeNodeIds: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Ids of nodes or config nodes to remove; wires and groups pointing at them are cleaned up.',
            },
            updateNodes: {
              type: 'array',
              items: { type: 'object' },
              description:
                'Patches, each with the id of an existing node and the properties to merge; arrays such as wires are replaced whole.',
            },
            replaceStrings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  property: {
                    type: 'string',
                    description: 'Top-level string property, e.g. func.',
                  },
                  old: { type: 'string' },
                  new: { type: 'string' },
                  replaceAll: { type: 'boolean' },
                },
                required: ['id', 'property', 'old', 'new'],
              },
              description:
                'Exact text replacements inside a string property. Fails when old is missing, or occurs more than once without replaceAll. Use for small edits to func or template.',
            },
            addNodes: {
              type: 'array',
              items: { type: 'object' },
              description: 'Nodes to append, each with at least id and type; z defaults to flowId.',
            },
            addConfigs: {
              type: 'array',
              items: { type: 'object' },
              description: 'Flow-scoped config nodes to append, same shape as addNodes.',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'validate_flow',
        description:
          'Check a flow without deploying it: ids, wires, group references, z and whether every node type is installed.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: {
              type: 'object',
              description: 'Flow object: {id, label, nodes: [], configs: []}.',
            },
          },
          required: ['flow'],
        },
      },
      {
        name: 'delete_flow',
        description: 'Delete a flow tab and all its nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'get_subflows',
        description: 'Get every subflow definition.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'create_subflow',
        description: 'Create a subflow definition.',
        inputSchema: {
          type: 'object',
          properties: {
            subflow: {
              type: 'object',
              description:
                'Subflow object: {id, type: "subflow", name, in: [], out: [], nodes: [], configs: []}.',
            },
          },
          required: ['subflow'],
        },
      },
      {
        name: 'update_subflow',
        description: 'Merge fields into a subflow definition; id and type cannot be changed.',
        inputSchema: {
          type: 'object',
          properties: {
            subflowId: {
              type: 'string',
            },
            updates: {
              type: 'object',
              description: 'Fields to update: {name, in, out, nodes, configs, env, ...}.',
            },
          },
          required: ['subflowId', 'updates'],
        },
      },
      {
        name: 'delete_subflow',
        description:
          'Delete a subflow definition. Errors if a flow still contains an instance of it.',
        inputSchema: {
          type: 'object',
          properties: {
            subflowId: {
              type: 'string',
            },
          },
          required: ['subflowId'],
        },
      },
      {
        name: 'create_global_config_node',
        description:
          'Create a global config node, reachable from all flows. Errors if the id exists or the node has a z property.',
        inputSchema: {
          type: 'object',
          properties: {
            node: {
              type: 'object',
              description: 'Config node with id, type, name and type-specific fields, without z.',
            },
          },
          required: ['node'],
        },
      },
      {
        name: 'update_global_config_node',
        description:
          'Replace a global config node. Errors if it does not exist or the replacement has a z property.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
            },
            node: {
              type: 'object',
              description: 'Replacement node, without z.',
            },
          },
          required: ['nodeId', 'node'],
        },
      },
      {
        name: 'delete_global_config_node',
        description:
          'Delete a global config node. Errors if it does not exist or is still referenced.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
            },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'get_flow_state',
        description:
          'Report whether the flows are started or stopped. Requires runtimeState enabled in the Node-RED settings.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'set_flow_state',
        description:
          'Start or stop all flows. Requires runtimeState enabled in the Node-RED settings.',
        inputSchema: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              enum: ['start', 'stop'],
            },
          },
          required: ['state'],
        },
      },
      {
        name: 'get_context',
        description: 'Read a context store value. Omit key to list the keys in the scope.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['global', 'flow', 'node'],
            },
            id: {
              type: 'string',
              description: 'Flow or node id, required for those scopes.',
            },
            key: {
              type: 'string',
            },
            store: {
              type: 'string',
            },
          },
          required: ['scope'],
        },
      },
      {
        name: 'delete_context',
        description: 'Delete a context store value.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['global', 'flow', 'node'],
            },
            id: {
              type: 'string',
              description: 'Flow or node id, required for those scopes.',
            },
            key: {
              type: 'string',
            },
            store: {
              type: 'string',
            },
          },
          required: ['scope', 'key'],
        },
      },
      {
        name: 'get_nodes',
        description:
          'List installed node modules with version, enabled state and the types each node set registers.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_node_help',
        description:
          'Documentation for a node type as markdown, with the properties the node stores and their defaults. Pass type, or module and set.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Node type as used in flows (e.g. "mqtt in").',
            },
            module: {
              type: 'string',
              description: 'Module name (e.g. "node-red", "@scope/name").',
            },
            set: {
              type: 'string',
              description: 'Node set name within the module.',
            },
            raw: {
              type: 'boolean',
              description: 'Return the full node config HTML instead of the help section.',
            },
          },
        },
      },
      {
        name: 'install_node',
        description: 'Install a node module from npm.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
            },
          },
          required: ['module'],
        },
      },
      {
        name: 'set_node_module_state',
        description: 'Enable or disable a node module.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
            },
            enabled: {
              type: 'boolean',
            },
          },
          required: ['module', 'enabled'],
        },
      },
      {
        name: 'remove_node_module',
        description: 'Remove an installed node module. Core modules cannot be removed.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
            },
          },
          required: ['module'],
        },
      },
      {
        name: 'get_settings',
        description: 'Runtime settings: version, httpNodeRoot, user and more.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_diagnostics',
        description: 'Runtime diagnostics: Node.js version, OS details and memory usage.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'trigger_inject',
        description: 'Fire a deployed inject node with its configured values.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
            },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'set_debug_state',
        description: 'Enable or disable a debug node.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
            },
            enabled: {
              type: 'boolean',
            },
          },
          required: ['nodeId', 'enabled'],
        },
      },
    ].map((tool) => ({ ...tool, annotations: TOOL_ANNOTATIONS[tool.name] })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // extra.signal fires when the caller cancels the request, so bind it to the HTTP calls this
    // handler is about to make instead of letting them run on to completion.
    const scoped = client.withSignal(extra.signal);

    try {
      switch (request.params.name) {
        case 'list_flows':
          return await listFlows(scoped);
        case 'get_flow':
          return await getFlow(scoped, request.params.arguments);
        case 'create_flow':
          return await createFlow(scoped, request.params.arguments);
        case 'update_flow':
          return await updateFlow(scoped, request.params.arguments);
        case 'patch_flow':
          return await patchFlow(scoped, request.params.arguments);
        case 'validate_flow':
          return await validateFlow(scoped, request.params.arguments);
        case 'delete_flow':
          return await deleteFlow(scoped, request.params.arguments);
        case 'get_subflows':
          return await getSubflows(scoped);
        case 'create_subflow':
          return await createSubflow(scoped, request.params.arguments);
        case 'update_subflow':
          return await updateSubflow(scoped, request.params.arguments);
        case 'delete_subflow':
          return await deleteSubflow(scoped, request.params.arguments);
        case 'create_global_config_node':
          return await createGlobalConfigNode(scoped, request.params.arguments);
        case 'update_global_config_node':
          return await updateGlobalConfigNode(scoped, request.params.arguments);
        case 'delete_global_config_node':
          return await deleteGlobalConfigNode(scoped, request.params.arguments);
        case 'get_flow_state':
          return await getFlowState(scoped);
        case 'set_flow_state':
          return await setFlowState(scoped, request.params.arguments);
        case 'get_context':
          return await getContext(scoped, request.params.arguments);
        case 'delete_context':
          return await deleteContext(scoped, request.params.arguments);
        case 'get_nodes':
          return await getNodes(scoped);
        case 'get_node_help':
          return await getNodeHelp(scoped, request.params.arguments);
        case 'install_node':
          return await installNode(scoped, request.params.arguments);
        case 'set_node_module_state':
          return await setNodeModuleState(scoped, request.params.arguments);
        case 'remove_node_module':
          return await removeNodeModule(scoped, request.params.arguments);
        case 'get_settings':
          return await getSettings(scoped);
        case 'get_diagnostics':
          return await getDiagnostics(scoped);
        case 'trigger_inject':
          return await triggerInject(scoped, request.params.arguments);
        case 'set_debug_state':
          return await setDebugState(scoped, request.params.arguments);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      const text =
        error instanceof ZodError
          ? formatZodError(request.params.name, error)
          : `Error: ${error instanceof Error ? error.message : String(error)}`;

      return { ...textResult(text), isError: true };
    }
  });

  return server;
}
