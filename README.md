# Node-RED MCP Server

MCP server for Node-RED workflow management. Provides AI assistants with 27 tools to manage flows, node modules, context stores, and runtime settings through the Node-RED Admin API v2.

## Installation

<details>
<summary><strong>Claude Code</strong></summary>

**Standalone Node-RED:**
```bash
claude mcp add node-red -e NODE_RED_URL=http://localhost:1880 -e NODE_RED_TOKEN=your-api-token -- npx mcp-node-red
```

**Home Assistant Add-on (Basic Auth):**
```bash
claude mcp add node-red -e NODE_RED_URL=http://username:password@homeassistant.local:1880 -- npx mcp-node-red
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "node-red": {
      "command": "npx",
      "args": ["mcp-node-red"],
      "env": {
        "NODE_RED_URL": "http://localhost:1880",
        "NODE_RED_TOKEN": "your-api-token"
      }
    }
  }
}
```

Restart Claude Desktop to load the server.

</details>

## Configuration

### Environment Variables

- `NODE_RED_URL` (required): Your Node-RED instance URL
- `NODE_RED_TOKEN` (optional): API token for authentication
- `MCP_TRANSPORT` (optional): `stdio` (default) or `streamable-http`
- `MCP_HOST`, `MCP_PORT`, `MCP_PATH` (optional): where the HTTP transport listens, default
  `127.0.0.1:3000/mcp`
- `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` (optional): comma-separated header values the HTTP
  transport accepts

### Timeouts

Requests to Node-RED give up after 5 seconds without a connection and 30 seconds without a
response or a body, instead of undici's 300 second default. `install_node` runs npm inside
Node-RED, which can legitimately take minutes, so that one call is allowed 300 seconds.

A read that fails because the connection was refused or reset, which is what a restarting
Node-RED looks like right after an install or an add-on update, is retried once after half a
second. Writes are never retried.

## Transports

By default the server speaks JSON-RPC over stdio, which is what most MCP clients launch.

Set `MCP_TRANSPORT=streamable-http` to listen over HTTP instead:

```bash
MCP_TRANSPORT=streamable-http MCP_PORT=3000 npx mcp-node-red
```

Each request gets its own server instance, so there is no session state to keep. The listener
binds to `127.0.0.1` and checks the `Host` header, because it carries your Node-RED credentials
and a page open in your browser can reach a loopback port. Serving it anywhere but loopback means
setting `MCP_ALLOWED_HOSTS` yourself, and putting authentication in front of it.

### Environment Files

The server loads environment variables from `.env` and `.env.local` files in the working directory:

- `.env` -- Base defaults (tracked in version control if desired)
- `.env.local` -- Local overrides (gitignored, never committed)

Precedence (highest to lowest):
1. Real environment variables (e.g., set via shell or MCP config)
2. `.env.local`
3. `.env`

Copy `.env.example` as a starting template:
```bash
cp .env.example .env
```

### Node-RED Setup

#### Standalone Node-RED

1. Enable Admin API in Node-RED `settings.js`:
```javascript
adminAuth: {
  type: "credentials",
  users: [{
    username: "admin",
    password: "$2a$08$...",  // bcrypt hash
    permissions: "*"
  }]
}
```

2. Generate API token:
```bash
curl -X POST http://localhost:1880/auth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id":"node-red-admin","grant_type":"password","scope":"*","username":"admin","password":"your-password"}'
```

#### Home Assistant Add-on

The Home Assistant Node-RED add-on uses Basic Auth with your Home Assistant credentials:

```bash
# Test connection
curl http://USERNAME:PASSWORD@homeassistant.local:1880/flows
```

**Configuration**:
```json
{
  "mcpServers": {
    "node-red": {
      "command": "npx",
      "args": ["mcp-node-red"],
      "env": {
        "NODE_RED_URL": "http://admin:your-ha-password@homeassistant.local:1880"
      }
    }
  }
}
```

Note: No `NODE_RED_TOKEN` needed - credentials are in the URL.

## Features

### Flow Management
- **list_flows**: List flow tabs (id, label, and disabled when the tab is disabled) without pulling every node
- **get_flow**: Retrieve a flow by ID, with optional `nodeIds` and `types` filters and a `summary` mode that keeps only structure
- **create_flow**: Create new flows via POST /flow
- **update_flow**: Replace a whole flow safely via PUT /flow/:id
- **patch_flow**: Change part of a flow: add, update and remove nodes and flow-scoped config nodes without resending the rest
- **validate_flow**: Validate a flow without deploying: required fields, unique ids, wires and group references that resolve, `z` matching the flow, and every node type installed or a known subflow
- **delete_flow**: Delete a flow and all its nodes by ID

### Subflows and Global Config Nodes
- **get_subflows**: List all subflow definitions from the global flow
- **create_subflow**: Add a subflow definition
- **update_subflow**: Merge changes into an existing subflow definition
- **delete_subflow**: Remove a subflow, refused while instances of it remain in flows
- **create_global_config_node**: Add a config node available to all flows
- **update_global_config_node**: Replace a global config node
- **delete_global_config_node**: Remove a global config node, refused while it is referenced

The six writing tools deploy through `POST /flows` with the revision the configuration was read
at, so a deploy from the editor in between is refused by Node-RED instead of overwritten. The
change is then reapplied to the fresh configuration once; a second conflict is reported and
nothing is written.

### Runtime Control
- **get_flow_state**: Get runtime state of flows (started/stopped)
- **set_flow_state**: Start or stop all flows in the runtime

### Node Module Management
- **get_nodes**: List installed node modules grouped per module, with version, enabled state and the node types each node set registers
- **get_node_help**: Get the documentation for a node type as markdown, the same help shown in the editor info sidebar, plus the properties the node stores, read from the `defaults` of its editor definition with their types and default values
- **install_node**: Install a node module from the npm registry
- **set_node_module_state**: Enable or disable an installed node module
- **remove_node_module**: Uninstall a node module from Node-RED

### Context Store
- **get_context**: Read context data at global, flow, or node scope
- **delete_context**: Delete context values at any scope

### Runtime Info
- **get_settings**: Get Node-RED runtime settings including version
- **get_diagnostics**: Get system diagnostics (Node.js, OS, memory)

### Node Interaction
- **trigger_inject**: Trigger an inject node (same as clicking the button)
- **set_debug_state**: Enable or disable a debug node's output

## Usage

Once configured, ask your AI assistant natural language questions:

```
List the flow tabs in my Node-RED instance
```

```
Create a new flow with label "Temperature Monitor"
```

```
Update flow "flow1" to change its label to "New Name"
```

```
Delete the flow with ID "flow1"
```

```
What node modules are installed?
```

```
Show me the help for the inject node
```

```
Install the node-red-contrib-mqtt module
```

```
Trigger the inject node to test my flow
```

```
Show me the global context data
```

```
Get the Node-RED runtime settings and version
```

## Safety Features

- **Individual flow updates**: Uses PUT /flow/:id to update only the specified flow
- **No accidental deletions**: Other flows remain completely untouched
- **Optimistic locking**: Subflow and global config node writes carry the revision they read, so a
  concurrent editor deploy is detected and retried once instead of overwritten
- **Validation**: All flow configurations are validated before sending to Node-RED
- **Read-only by default**: Only modifies flows when explicitly requested
- **Module management guards**: Core modules cannot be removed; enable/disable is reversible
- **Scoped context operations**: Context reads and deletes are scoped to specific keys

## Development

See [docs/development.md](docs/development.md) for development setup, testing, and contribution guidelines.

## License

MIT
