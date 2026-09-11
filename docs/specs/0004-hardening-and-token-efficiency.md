# Hardening and Token Efficiency

## Overview

A series of batches that make the server harder to break (timeouts, cancellation, encoding,
bounded error output) and cheaper to talk to (compact responses, partial flow reads and writes,
fewer round trips). Each batch lands as one commit on main.

## Background

The tools were built endpoint by endpoint against the Admin API, and the gaps that are left are
mostly in the seams: undici's 300 second default timeouts, path segments interpolated without
encoding, whole HTML error pages pasted into error messages, and pretty-printed JSON in every
response. Nothing here changes what the tools are for; it changes how they behave when Node-RED,
the network or the caller misbehaves, and how much of the context window a call costs.

## Tasks

### Batch 1, stability

- [x] `create_flow` accepts a flow without id; id comes back from Node-RED
- [x] HTTP timeouts via a shared undici `Agent`, and MCP request cancellation reaches undici
- [x] URL-encode path segments in `getContext`, `deleteContext`, `triggerInject`,
      `setDebugNodeState`, `setNodeModuleState`, `removeNodeModule`
- [x] Error responses from Node-RED are truncated and, when JSON, reduced to their message
- [x] `delete_global_config_node` reference check searches nested values
- [x] Server version read from `package.json`

### Batch 2, token usage (small)

- [ ] Compact JSON in all tool responses via one shared helper
- [ ] Zod validation errors rendered one line per issue
- [ ] `get_nodes` output grouped per module

### Batch 3, token usage (large)

- [ ] `patch_flow` tool for partial flow updates (add, replace, remove nodes, label, disabled)
- [ ] `get_flow` selection parameters (`nodeIds`, `types`, `summary`)
- [ ] Flow, subflow and config node parameters accepted as objects, strings still tolerated

### Batch 4, schema and speed

- [ ] `NodeSetSchema` that matches `GET /nodes`; remove the duplicate parse in `get_node_help`
- [ ] Node set cache in the client, invalidated by `install_node`, `remove_node_module`,
      `set_node_module_state`
- [ ] Lightweight schema for `list_flows`
- [ ] Parallel fetches in `delete_subflow` and `delete_global_config_node`
- [ ] One retry on `ECONNREFUSED`/`ECONNRESET` for GET requests
- [ ] `validate_flow` checks wires, `z` and installed node types

### Batch 5, get_node_help

- [ ] Help HTML rendered as markdown
- [ ] Configurable properties read from the node's `defaults` in `RED.nodes.registerType`

### Batch 6, optimistic locking

Decided 2026-09-11: global flow writes move to `POST /flows` with `rev`, so a concurrent editor
deploy answers 409 instead of being overwritten. Hiding `get_flow_state` and `set_flow_state`
when `runtimeState` is disabled was considered and declined: it saves about 700 characters per
session and makes startup depend on Node-RED answering.

- [ ] Optimistic locking with `rev` for global flow writes (subflow and global config node tools)

## Design (batch 1)

**create_flow without id.** `POST /flow` generates an id when none is sent, but the tool
validated its input with `UpdateFlowRequestSchema`, whose `id` is required, so the documented
auto-generation was unreachable. `CreateFlowRequestSchema` makes `id` optional; the client reads
the generated id from the 200 body, falls back to the id it sent on a 204, and errors clearly
when neither is available.

**Timeouts and cancellation.** One module-level `Agent` carries a 5 s connect timeout and 30 s
header and body timeouts, replacing undici's 300 s defaults. `installNode` overrides both to
300 s per request because it runs npm inside Node-RED. `NodeRedClient.withSignal` returns a view
of the client bound to the `AbortSignal` the MCP SDK passes to each request handler, so a
cancelled call aborts the HTTP request instead of running to completion.

**Encoding.** Context ids and keys and node ids are single path segments and are now
percent-encoded. Module names go through `encodeNodePath`, which keeps the literal slash and `@`
that Node-RED's `/nodes/:module/:set` route requires for scoped packages.

**Error bodies.** One `fail` helper reads the body once, prefers the `message` of a JSON
`{code, message}` error, and otherwise collapses whitespace and caps the text at 500 characters.
Behind an ingress or proxy the body is often a full HTML page.

## References

- [Node-RED Admin API: POST /flow](https://nodered.org/docs/api/admin/methods/post/flow/) - id is
  optional and generated when omitted
- [Node-RED Admin API: context](https://nodered.org/docs/api/admin/methods/get/context/) - scope,
  id and key path segments
- [undici Agent](https://undici.nodejs.org/#/docs/api/Agent) and
  [Dispatcher.RequestOptions](https://undici.nodejs.org/#/docs/api/Dispatcher) - `connectTimeout`,
  `headersTimeout`, `bodyTimeout`, `signal`
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -
  `RequestHandlerExtra.signal` on request handlers
