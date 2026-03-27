import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { NodeRedClient } from './client.js';
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
import { getFlows } from './tools/get-flows.js';
import { getNodeHelp } from './tools/get-node-help.js';
import { getNodes } from './tools/get-nodes.js';
import { getSettings } from './tools/get-settings.js';
import { getSubflows } from './tools/get-subflows.js';
import { installNode } from './tools/install-node.js';
import { removeNodeModule } from './tools/remove-node-module.js';
import { setDebugState } from './tools/set-debug-state.js';
import { setFlowState } from './tools/set-flow-state.js';
import { setNodeModuleState } from './tools/set-node-module-state.js';
import { triggerInject } from './tools/trigger-inject.js';
import { updateFlow } from './tools/update-flow.js';
import { updateGlobalConfigNode } from './tools/update-global-config-node.js';
import { updateSubflow } from './tools/update-subflow.js';
import { validateFlow } from './tools/validate-flow.js';

export function createServer() {
  const nodeRedUrl = process.env.NODE_RED_URL;
  const nodeRedToken = process.env.NODE_RED_TOKEN;

  if (!nodeRedUrl) {
    throw new Error('NODE_RED_URL environment variable is required');
  }

  const config = ConfigSchema.parse({
    nodeRedUrl,
    nodeRedToken,
  });

  const client = new NodeRedClient(config);

  const server = new Server(
    {
      name: 'node-red-mcp-server',
      version: '1.0.0',
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
        name: 'get_flows',
        description:
          'Get all flows from Node-RED instance. Returns current flows configuration including revision number.',
        inputSchema: {
          type: 'object',
          properties: {},
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
              type: 'string',
              description:
                'JSON string containing flow data with format: {id, label, nodes: [], configs: []}',
            },
          },
          required: ['flow'],
        },
      },
      {
        name: 'update_flow',
        description:
          'Update a specific flow by ID using PUT /flow/:id. Only affects the specified flow, leaving all other flows untouched. Requires flow object with id, label, nodes array, and optional configs array.',
        inputSchema: {
          type: 'object',
          properties: {
            flowId: {
              type: 'string',
              description: 'ID of the flow to update',
            },
            updates: {
              type: 'string',
              description:
                'JSON string containing flow update with format: {id, label, nodes: [], configs: []}',
            },
          },
          required: ['flowId', 'updates'],
        },
      },
      {
        name: 'validate_flow',
        description:
          'Validate flow configuration without deploying. Checks for required fields and structural integrity.',
        inputSchema: {
          type: 'object',
          properties: {
            flow: {
              type: 'string',
              description:
                'JSON string containing flow data with format: {id, label, nodes: [], configs: []}',
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
          'Create a new subflow definition in Node-RED. Subflows are reusable components with named inputs and outputs. The subflow is added to the global flow.',
        inputSchema: {
          type: 'object',
          properties: {
            subflow: {
              type: 'string',
              description:
                'JSON string with subflow data: {id, type: "subflow", name, in: [], out: [], nodes: [], configs: []}',
            },
          },
          required: ['subflow'],
        },
      },
      {
        name: 'update_subflow',
        description:
          'Update an existing subflow definition by ID. Only the specified subflow is modified.',
        inputSchema: {
          type: 'object',
          properties: {
            subflowId: {
              type: 'string',
              description: 'ID of the subflow to update',
            },
            updates: {
              type: 'string',
              description:
                'JSON string with fields to update: {name, in, out, nodes, configs, env, ...}',
            },
          },
          required: ['subflowId', 'updates'],
        },
      },
      {
        name: 'delete_subflow',
        description:
          'Delete a subflow definition from Node-RED by ID. Removes the subflow from the global flow.',
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
          'Create a new global config node (no z property) accessible from all flows. Uses PUT /flows with Node-RED-Deployment-Type: nodes. Errors if a node with that id already exists or if the node contains a z property.',
        inputSchema: {
          type: 'object',
          properties: {
            node: {
              type: 'string',
              description:
                'JSON string of the config node object with id, type, name, and type-specific fields. Must not include a z property.',
            },
          },
          required: ['node'],
        },
      },
      {
        name: 'update_global_config_node',
        description:
          'Update an existing global config node by replacing it. Uses PUT /flows with Node-RED-Deployment-Type: nodes. Errors if the node does not exist, has a z property, or the replacement contains a z property.',
        inputSchema: {
          type: 'object',
          properties: {
            nodeId: {
              type: 'string',
              description: 'ID of the global config node to update',
            },
            node: {
              type: 'string',
              description:
                'JSON string with the replacement node object. Must not include a z property.',
            },
          },
          required: ['nodeId', 'node'],
        },
      },
      {
        name: 'delete_global_config_node',
        description:
          'Delete a global config node by ID. Uses PUT /flows with Node-RED-Deployment-Type: nodes. Errors if the node does not exist, has a z property, or is still referenced by other nodes.',
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
          'Get all installed node modules from Node-RED. Returns array of node module objects with their node sets.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_node_help',
        description:
          'Get the documentation for a node type: the same help shown in the Node-RED editor info sidebar. Pass "type" with a node type as it appears in a flow (e.g. "inject", "mqtt in") and it is resolved to its module and set, or pass "module" and "set" directly. Set "raw" to get the full node config HTML including the edit dialog and editor JavaScript.',
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      switch (request.params.name) {
        case 'get_flows':
          return await getFlows(client);
        case 'create_flow':
          return await createFlow(client, request.params.arguments);
        case 'update_flow':
          return await updateFlow(client, request.params.arguments);
        case 'validate_flow':
          return await validateFlow(client, request.params.arguments);
        case 'delete_flow':
          return await deleteFlow(client, request.params.arguments);
        case 'get_subflows':
          return await getSubflows(client);
        case 'create_subflow':
          return await createSubflow(client, request.params.arguments);
        case 'update_subflow':
          return await updateSubflow(client, request.params.arguments);
        case 'delete_subflow':
          return await deleteSubflow(client, request.params.arguments);
        case 'create_global_config_node':
          return await createGlobalConfigNode(client, request.params.arguments);
        case 'update_global_config_node':
          return await updateGlobalConfigNode(client, request.params.arguments);
        case 'delete_global_config_node':
          return await deleteGlobalConfigNode(client, request.params.arguments);
        case 'get_flow_state':
          return await getFlowState(client);
        case 'set_flow_state':
          return await setFlowState(client, request.params.arguments);
        case 'get_context':
          return await getContext(client, request.params.arguments);
        case 'delete_context':
          return await deleteContext(client, request.params.arguments);
        case 'get_nodes':
          return await getNodes(client);
        case 'get_node_help':
          return await getNodeHelp(client, request.params.arguments);
        case 'install_node':
          return await installNode(client, request.params.arguments);
        case 'set_node_module_state':
          return await setNodeModuleState(client, request.params.arguments);
        case 'remove_node_module':
          return await removeNodeModule(client, request.params.arguments);
        case 'get_settings':
          return await getSettings(client);
        case 'get_diagnostics':
          return await getDiagnostics(client);
        case 'trigger_inject':
          return await triggerInject(client, request.params.arguments);
        case 'set_debug_state':
          return await setDebugState(client, request.params.arguments);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

export async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
