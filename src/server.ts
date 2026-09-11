import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
        description:
          'List all flow tabs: id, label and disabled when the tab is disabled. Use this before get_flow to discover flow IDs.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_flow',
        description:
          'Get a flow tab by ID with all its nodes and flow-scoped config nodes. nodeIds and types keep only matching nodes (either filter matches). summary reduces each node to id, type, name, group and wires, which is enough to understand structure but is NOT a valid input for update_flow; use patch_flow for changes.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
              description: 'ID of the flow tab to retrieve',
            },
            nodeIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only nodes and config nodes with these ids.',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Keep only nodes and config nodes of these types (e.g. "inject").',
            },
            summary: {
              type: 'boolean',
              description:
                'Reduce each node to id, type, name, group and wires instead of its full configuration.',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'create_flow',
        description:
          'Create a new flow using POST /flow. Adds a new flow to Node-RED. Flow ID can be provided or will be auto-generated.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: {
              type: 'object',
              description:
                'Flow object: {id?, label, nodes: [], configs: []}. A JSON string with the same content is also accepted.',
            },
          },
          required: ['flow'],
        },
      },
      {
        name: 'update_flow',
        description:
          'Update a specific flow by ID using PUT /flow/:id. Only affects the specified flow, leaving all other flows untouched. Replaces the flow with what is sent, so the whole node list has to be included; use patch_flow to change part of an existing flow.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
              description: 'ID of the flow to update',
            },
            updates: {
              type: 'object',
              description:
                'Flow object: {id, label, nodes: [], configs: []}. A JSON string with the same content is also accepted.',
            },
          },
          required: ['flowId', 'updates'],
        },
      },
      {
        name: 'patch_flow',
        description:
          'Change part of a flow without resending it: remove, update (shallow merge by id) and add nodes and flow-scoped config nodes, and set label, disabled or info. Wires and group membership that point at removed nodes are cleaned up. Reads the flow, applies the changes and writes it back with PUT /flow/:id, so an editor deploy of the same flow between the read and the write is overwritten. Prefer this over update_flow for changes to an existing flow.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
              description: 'ID of the flow to patch',
            },
            label: {
              type: 'string',
              description: 'New label for the flow tab.',
            },
            disabled: {
              type: 'boolean',
              description: 'Whether the flow tab is disabled.',
            },
            info: {
              type: 'string',
              description: 'New description text for the flow tab.',
            },
            removeNodeIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ids of nodes or flow-scoped config nodes to remove from the flow.',
            },
            updateNodes: {
              type: 'array',
              items: { type: 'object' },
              description:
                'Node patches, each with the id of an existing node and the properties to merge into it; arrays such as wires are replaced whole.',
            },
            addNodes: {
              type: 'array',
              items: { type: 'object' },
              description:
                'Nodes to append to the flow, each with at least id and type; z is set to the flow id when missing.',
            },
            addConfigs: {
              type: 'array',
              items: { type: 'object' },
              description:
                'Flow-scoped config nodes to append, each with at least id and type; z is set to the flow id when missing.',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'validate_flow',
        description:
          'Validate a flow without deploying: required fields, unique ids, wires and group references that resolve, z matching the flow, and every node type installed or a known subflow.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: {
              type: 'object',
              description:
                'Flow object: {id, label, nodes: [], configs: []}. A JSON string with the same content is also accepted.',
            },
          },
          required: ['flow'],
        },
      },
      {
        name: 'delete_flow',
        description: 'Delete a flow from Node-RED by ID. Removes the flow and all its nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
              description: 'ID of the flow to delete',
            },
          },
          required: ['flowId'],
        },
      },
      {
        name: 'get_subflows',
        description:
          'Get all subflow definitions from Node-RED. Subflows are reusable flow components stored in the global flow.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'create_subflow',
        description:
          'Create a new subflow definition in Node-RED. Subflows are reusable components with named inputs and outputs. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            subflow: {
              type: 'object',
              description:
                'Subflow object: {id, type: "subflow", name, in: [], out: [], nodes: [], configs: []}. A JSON string with the same content is also accepted.',
            },
          },
          required: ['subflow'],
        },
      },
      {
        name: 'update_subflow',
        description:
          'Update an existing subflow definition by ID. Fields in "updates" are merged into the existing definition; id and type cannot be changed. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            subflowId: {
              type: 'string',
              description: 'ID of the subflow to update',
            },
            updates: {
              type: 'object',
              description:
                'Object with the fields to update: {name, in, out, nodes, configs, env, ...}. A JSON string with the same content is also accepted.',
            },
          },
          required: ['subflowId', 'updates'],
        },
      },
      {
        name: 'delete_subflow',
        description:
          'Delete a subflow definition from Node-RED by ID. Errors if any flow still contains an instance of the subflow. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            subflowId: {
              type: 'string',
              description: 'ID of the subflow to delete',
            },
          },
          required: ['subflowId'],
        },
      },
      {
        name: 'create_global_config_node',
        description:
          'Create a new global config node (no z property) accessible from all flows. Errors if a node with that id already exists or if the node contains a z property. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            node: {
              type: 'object',
              description:
                'Config node object with id, type, name and type-specific fields. Must not include a z property. A JSON string with the same content is also accepted.',
            },
          },
          required: ['node'],
        },
      },
      {
        name: 'update_global_config_node',
        description:
          'Update an existing global config node by replacing it. Errors if the node does not exist or if the replacement contains a z property. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: 'ID of the global config node to update',
            },
            node: {
              type: 'object',
              description:
                'Replacement node object. Must not include a z property. A JSON string with the same content is also accepted.',
            },
          },
          required: ['nodeId', 'node'],
        },
      },
      {
        name: 'delete_global_config_node',
        description:
          'Delete a global config node by ID. Errors if the node does not exist or is still referenced by other nodes. Rewrites the global flow, so a concurrent editor deploy can be overwritten.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: 'ID of the global config node to delete',
            },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'get_flow_state',
        description:
          'Get the runtime state of Node-RED flows. Returns whether flows are currently started or stopped. Requires runtimeState to be enabled in Node-RED settings.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'set_flow_state',
        description:
          'Set the runtime state of Node-RED flows to start or stop them. Requires runtimeState to be enabled in Node-RED settings.',
        inputSchema: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              enum: ['start', 'stop'],
              description: 'The desired flow state: "start" to run flows, "stop" to halt them',
            },
          },
          required: ['state'],
        },
      },
      {
        name: 'get_context',
        description:
          'Read context store data at global, flow, or node scope. Omit key to list all keys.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['global', 'flow', 'node'],
              description: 'Context scope to read from',
            },
            id: {
              type: 'string',
              description: 'Flow or node ID (required for flow and node scope)',
            },
            key: {
              type: 'string',
              description: 'Context key to read. Omit to list all keys.',
            },
            store: {
              type: 'string',
              description: 'Optional context store name',
            },
          },
          required: ['scope'],
        },
      },
      {
        name: 'delete_context',
        description: 'Delete a context store value at global, flow, or node scope.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['global', 'flow', 'node'],
              description: 'Context scope to delete from',
            },
            id: {
              type: 'string',
              description: 'Flow or node ID (required for flow and node scope)',
            },
            key: {
              type: 'string',
              description: 'Context key to delete',
            },
            store: {
              type: 'string',
              description: 'Optional context store name',
            },
          },
          required: ['scope', 'key'],
        },
      },
      {
        name: 'get_nodes',
        description:
          'List installed node modules, grouped per module with version, enabled state and the node types each node set registers. Use get_node_help for the documentation of a type.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_node_help',
        description:
          'Get the documentation for a node type as markdown, with the properties the node stores (from its editor definition) and their defaults. Pass "type" with a node type as it appears in a flow (e.g. "inject", "mqtt in") and it is resolved to its module and set, or pass "module" and "set" directly. Set "raw" to get the full node config HTML including the edit dialog and editor JavaScript.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description:
                'Node type as used in flows (e.g. "inject", "mqtt in"). Resolved to a module and set via the installed node list.',
            },
            module: {
              type: 'string',
              description:
                'Node module name (e.g. "node-red", "node-red-contrib-zigbee2mqtt"). Use together with "set" instead of "type".',
            },
            set: {
              type: 'string',
              description: 'Node set name within the module (e.g. "inject", "zigbee2mqtt-in")',
            },
            raw: {
              type: 'boolean',
              description:
                'Return the full node config HTML instead of just the help section. Defaults to false.',
            },
          },
        },
      },
      {
        name: 'install_node',
        description: 'Install a new node module into Node-RED. Installs from the npm registry.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
              description: 'Name of the npm module to install (e.g. "node-red-contrib-example")',
            },
          },
          required: ['module'],
        },
      },
      {
        name: 'set_node_module_state',
        description:
          'Enable or disable a node module in Node-RED. When disabled, the module nodes are unavailable.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
              description: 'Name of the node module to enable/disable',
            },
            enabled: {
              type: 'boolean',
              description: 'Whether to enable (true) or disable (false) the module',
            },
          },
          required: ['module', 'enabled'],
        },
      },
      {
        name: 'remove_node_module',
        description: 'Remove an installed node module from Node-RED. Cannot remove core modules.',
        inputSchema: {
          type: 'object',
          properties: {
            module: {
              type: 'string',
              description: 'Name of the node module to remove',
            },
          },
          required: ['module'],
        },
      },
      {
        name: 'get_settings',
        description:
          'Get the runtime settings of the Node-RED instance. Returns server configuration including version, httpNodeRoot, and user info.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_diagnostics',
        description:
          'Get diagnostic information about the Node-RED runtime. Returns system info including Node.js version, OS details, and memory usage.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'trigger_inject',
        description:
          'Trigger an inject node to fire with its configured values. The node must be a deployed inject node.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: 'ID of the inject node to trigger',
            },
          },
          required: ['nodeId'],
        },
      },
      {
        name: 'set_debug_state',
        description:
          'Enable or disable a debug node. When disabled, the debug node will not produce output.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: 'ID of the debug node',
            },
            enabled: {
              type: 'boolean',
              description: 'Whether to enable (true) or disable (false) the debug node',
            },
          },
          required: ['nodeId', 'enabled'],
        },
      },
    ],
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
