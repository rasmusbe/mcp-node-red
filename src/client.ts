import { Agent, request } from 'undici';
import { z } from 'zod';
import type {
  Config,
  CreateFlowRequest,
  FlowState,
  FlowTab,
  NodeModule,
  NodeRedDiagnostics,
  NodeRedFlowsResponse,
  NodeRedGlobalFlowResponse,
  NodeRedItem,
  NodeRedSettings,
  NodeSet,
  UpdateFlowRequest,
} from './schemas.js';
import {
  FlowStateSchema,
  FlowTabsResponseSchema,
  NodeModuleSchema,
  NodeRedDiagnosticsSchema,
  NodeRedFlowsResponseSchema,
  NodeRedGlobalFlowResponseSchema,
  NodeRedSettingsSchema,
  NodeSetSchema,
  SetFlowsResponseSchema,
} from './schemas.js';

/** Give up on an unreachable host quickly: nothing here is worth a long connect wait. */
export const CONNECT_TIMEOUT_MS = 5_000;
export const HEADERS_TIMEOUT_MS = 30_000;
export const BODY_TIMEOUT_MS = 30_000;

/**
 * POST /nodes runs npm inside Node-RED, which downloads and sometimes builds a package, so
 * minutes are normal there and the shared cap would abort an install that is working.
 */
export const INSTALL_TIMEOUT_MS = 300_000;

/**
 * How long a cached node set list is trusted. Modules only change when someone installs, removes
 * or disables one, and the editor is the other way of doing that, so a few minutes of staleness
 * costs nothing while a type lookup on every get_node_help costs a request each time.
 */
export const NODE_SET_CACHE_TTL_MS = 300_000;

/** Long enough for a restarting Node-RED to bind its port again, short enough not to be felt. */
export const RETRY_DELAY_MS = 500;

/** Enough of an error body to identify the failure, not enough to flood the transcript. */
const MAX_ERROR_DETAIL_CHARS = 500;

/**
 * undici defaults headersTimeout and bodyTimeout to 300 s, so a Node-RED that accepts the
 * connection and then stalls holds an MCP call open for five minutes with nothing to show for
 * it. One agent for the process also keeps the connection pool shared across requests.
 */
export const nodeRedAgent = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: HEADERS_TIMEOUT_MS,
  bodyTimeout: BODY_TIMEOUT_MS,
});

type HttpRequestOptions = NonNullable<Parameters<typeof request>[1]>;
type HttpResponse = Awaited<ReturnType<typeof request>>;

/**
 * A flow id is a single path segment, so anything in it that would be read as structure has to
 * be encoded. Without this an id like "../nodes" silently resolves to a different endpoint
 * instead of failing.
 */
function encodeFlowId(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Build the path segments for /nodes/:module/:set.
 *
 * Node-RED routes this endpoint with /^\/nodes\/((@[^\/]+\/)?[^\/]+)\/([^\/]+)$/, so the
 * separator in a scoped module name has to arrive as a literal slash and the leading @ has to
 * stay unencoded. Running encodeURIComponent over the whole string turns those into %2F and
 * %40: Express decodes them again, but Apache rejects encoded slashes by default and several
 * proxies rewrite them, so encode per segment instead and leave @ alone.
 */
function encodeNodePath(value: string): string {
  return value
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%40/g, '@'))
    .join('/');
}

/**
 * Node-RED answers its own errors with {code, message}, but a reverse proxy or the Home
 * Assistant ingress in front of it answers with an HTML page, and pasting that page into an
 * error message costs the caller thousands of tokens and says nothing. Prefer the message,
 * otherwise a single capped line.
 */
function describeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const detail = jsonErrorMessage(trimmed) ?? trimmed.replace(/\s+/g, ' ');
  return detail.length > MAX_ERROR_DETAIL_CHARS
    ? `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}...`
    : detail;
}

function jsonErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const { message } = parsed as { message?: unknown };
      if (typeof message === 'string') {
        return message;
      }
    }
  } catch {
    // Not JSON, so the raw text is all there is.
  }
  return undefined;
}

/**
 * Failures that mean the request never reached Node-RED: the port is closed, or the socket was
 * torn down mid-flight. A timeout is deliberately not here, because a request that Node-RED is
 * still working on would then be sent twice.
 */
const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    return code;
  }

  // undici wraps the socket error of a failed connect in cause.
  if (typeof cause === 'object' && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === 'string') {
      return nested;
    }
  }

  return undefined;
}

function isConnectionFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE_ERROR_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The deploy modes Node-RED accepts in Node-RED-Deployment-Type. "nodes" restarts only the nodes
 * the deploy actually changed, "flows" every node of a changed tab, "full" everything, and
 * "reload" discards the body and re-reads the stored flows.
 */
export type DeploymentType = 'full' | 'nodes' | 'flows' | 'reload';

/** Said when the 409 body carries nothing better, which is the usual case. */
const CONFLICT_MESSAGE = 'The Node-RED configuration changed since it was read';

/**
 * A POST /flows that Node-RED refused because the configuration moved on. The runtime compares
 * the rev in the body against the one it holds and answers 409 version_mismatch, and that is the
 * one write failure a caller can act on: read again and reapply, rather than report an error.
 */
export class FlowsConflictError extends Error {
  readonly name = 'FlowsConflictError';
}

export class NodeRedClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly basicAuth?: string;
  private readonly signal?: AbortSignal;

  /**
   * withSignal copies own properties into the view, so the cache has to be reachable through a
   * holder both objects point at. Reassigning a field here would only ever update one of them.
   */
  private readonly cache: {
    nodeSets?: { sets: NodeSet[]; fetchedAt: number };
    pending?: Promise<NodeSet[]>;
  } = {};

  constructor(config: Config) {
    const url = new URL(config.nodeRedUrl);

    // Extract basic auth from URL if present
    if (url.username || url.password) {
      this.basicAuth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
      url.username = '';
      url.password = '';
    }

    this.baseUrl = url.toString().replace(/\/$/, '');
    this.token = config.nodeRedToken;
  }

  /**
   * A view of this client whose requests abort with `signal`. The MCP SDK hands every request
   * handler a signal that fires when the caller cancels; without passing it on, a cancelled
   * call leaves the Node-RED request running and the connection tied up.
   */
  withSignal(signal?: AbortSignal): NodeRedClient {
    if (!signal) {
      return this;
    }

    return Object.assign(Object.create(Object.getPrototypeOf(this)), this, {
      signal,
    }) as NodeRedClient;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Node-RED-API-Version': 'v2',
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    } else if (this.basicAuth) {
      headers.Authorization = `Basic ${this.basicAuth}`;
    }

    return headers;
  }

  /**
   * Every request goes through here so the shared agent and the cancellation signal are attached
   * in one place, and so a GET that arrives while Node-RED is restarting (after install_node, or
   * when the Home Assistant add-on updates) gets one more chance instead of failing the call.
   * Only GET is retried: it is the one method where a second attempt cannot repeat a write.
   */
  private async send(url: string, init: HttpRequestOptions): Promise<HttpResponse> {
    const options = { ...init, dispatcher: nodeRedAgent, signal: this.signal };

    try {
      return await request(url, options);
    } catch (error) {
      if (init.method !== 'GET' || this.signal?.aborted || !isConnectionFailure(error)) {
        throw error;
      }
    }

    await delay(RETRY_DELAY_MS);
    return await request(url, options);
  }

  private async fail(action: string, response: HttpResponse): Promise<never> {
    let body = '';
    try {
      body = (await response.body.text()) ?? '';
    } catch {
      // A body that cannot be read still leaves us the status code.
    }

    const detail = describeErrorBody(body);
    throw new Error(`Failed to ${action}: ${response.statusCode} ${detail}`.trimEnd());
  }

  async getFlows(): Promise<NodeRedFlowsResponse> {
    const response = await this.send(`${this.baseUrl}/flows`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get flows', response);
    }

    // Validate the response, but hand back the JSON exactly as Node-RED sent it. setFlows writes
    // this list back, and Zod's passthrough emits the keys a schema declares before the rest, so
    // a parsed copy would move every node's wires ahead of its coordinates and rewrite the key
    // order of the whole of flows.json for anyone who keeps it in git.
    const data = await response.body.json();
    NodeRedFlowsResponseSchema.parse(data);
    return data as NodeRedFlowsResponse;
  }

  /**
   * Replace the whole configuration, under the revision it was read at.
   *
   * The rev is what makes this safe: Node-RED compares it against the revision it holds and
   * answers 409 instead of taking a write built on a configuration someone has since deployed
   * over. The default deployment type is the editor's own, "nodes", which restarts only the
   * nodes that actually changed rather than every flow.
   */
  async setFlows(
    flows: NodeRedItem[],
    rev: string,
    deploymentType: DeploymentType = 'nodes'
  ): Promise<{ rev: string }> {
    const headers = this.getHeaders();
    headers['Node-RED-Deployment-Type'] = deploymentType;

    const response = await this.send(`${this.baseUrl}/flows`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ rev, flows }),
    });

    if (response.statusCode === 409) {
      throw await this.conflict(response);
    }

    if (response.statusCode !== 200) {
      await this.fail('set flows', response);
    }

    return SetFlowsResponseSchema.parse(await response.body.json());
  }

  private async conflict(response: HttpResponse): Promise<FlowsConflictError> {
    let body = '';
    try {
      body = (await response.body.text()) ?? '';
    } catch {
      // The status already said what happened; the body only adds detail.
    }

    const message = jsonErrorMessage(body.trim());
    return new FlowsConflictError(message && message.length > 0 ? message : CONFLICT_MESSAGE);
  }

  /**
   * The tabs of GET /flows, without the nodes. The full response is around half a megabyte on a
   * busy instance and validating it against the item union costs several times what parsing the
   * JSON does, so read it with a schema that strips everything a tab listing does not use.
   */
  async listTabs(): Promise<FlowTab[]> {
    const response = await this.send(`${this.baseUrl}/flows`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get flows', response);
    }

    const data = FlowTabsResponseSchema.parse(await response.body.json());
    return data.flows
      .filter((item) => item.type === 'tab')
      .map((tab) => ({ id: tab.id, label: tab.label ?? '', disabled: tab.disabled }));
  }

  async createFlow(flowData: CreateFlowRequest): Promise<{ id: string }> {
    const response = await this.send(`${this.baseUrl}/flow`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(flowData),
    });

    if (response.statusCode !== 200 && response.statusCode !== 204) {
      await this.fail('create flow', response);
    }

    // A generated id only comes back in the 200 body, so a 204 is only usable when the caller
    // named the flow itself.
    if (response.statusCode === 200) {
      const data = (await response.body.json()) as { id?: unknown };
      if (typeof data?.id === 'string') {
        return { id: data.id };
      }
    }

    if (flowData.id) {
      return { id: flowData.id };
    }

    throw new Error(
      `Node-RED returned no id for the created flow (status ${response.statusCode}). Send the flow with an explicit id to control it.`
    );
  }

  async updateFlow(flowId: string, flowData: UpdateFlowRequest): Promise<{ id: string }> {
    const response = await this.send(`${this.baseUrl}/flow/${encodeFlowId(flowId)}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(flowData),
    });

    if (response.statusCode !== 200 && response.statusCode !== 204) {
      await this.fail('update flow', response);
    }

    if (response.statusCode === 204) {
      return { id: flowId };
    }
    const data = await response.body.json();
    return data as { id: string };
  }

  async getFlow(flowId: string): Promise<unknown> {
    const response = await this.send(`${this.baseUrl}/flow/${encodeFlowId(flowId)}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get flow', response);
    }

    return await response.body.json();
  }

  async getGlobalFlow(): Promise<NodeRedGlobalFlowResponse> {
    const response = await this.send(`${this.baseUrl}/flow/global`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get global flow', response);
    }

    const data = await response.body.json();
    return NodeRedGlobalFlowResponseSchema.parse(data);
  }

  async deleteFlow(flowId: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/flow/${encodeFlowId(flowId)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 204) {
      await this.fail('delete flow', response);
    }
  }

  async getFlowState(): Promise<FlowState> {
    const response = await this.send(`${this.baseUrl}/flows/state`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get flow state', response);
    }

    const data = await response.body.json();
    return FlowStateSchema.parse(data);
  }

  async setFlowState(state: 'start' | 'stop'): Promise<FlowState> {
    const response = await this.send(`${this.baseUrl}/flows/state`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ state }),
    });

    if (response.statusCode !== 200) {
      await this.fail('set flow state', response);
    }

    const data = await response.body.json();
    return FlowStateSchema.parse(data);
  }

  async getSettings(): Promise<NodeRedSettings> {
    const response = await this.send(`${this.baseUrl}/settings`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get settings', response);
    }

    const data = await response.body.json();
    return NodeRedSettingsSchema.parse(data);
  }

  async getDiagnostics(): Promise<NodeRedDiagnostics> {
    const response = await this.send(`${this.baseUrl}/diagnostics`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('get diagnostics', response);
    }

    const data = await response.body.json();
    return NodeRedDiagnosticsSchema.parse(data);
  }

  async getContext(
    scope: 'global' | 'flow' | 'node',
    id?: string,
    key?: string,
    store?: string
  ): Promise<unknown> {
    let url = `${this.baseUrl}/context/${scope}`;
    if (scope !== 'global' && id) {
      url += `/${encodeURIComponent(id)}`;
    }
    if (key) {
      url += `/${encodeURIComponent(key)}`;
    }
    if (store) {
      url += `?store=${encodeURIComponent(store)}`;
    }

    const response = await this.send(url, { method: 'GET', headers: this.getHeaders() });

    if (response.statusCode !== 200) {
      await this.fail('get context', response);
    }

    return await response.body.json();
  }

  async deleteContext(
    scope: 'global' | 'flow' | 'node',
    id?: string,
    key?: string,
    store?: string
  ): Promise<void> {
    let url = `${this.baseUrl}/context/${scope}`;
    if (scope === 'global') {
      url += `/${encodeURIComponent(key ?? '')}`;
    } else {
      url += `/${encodeURIComponent(id ?? '')}/${encodeURIComponent(key ?? '')}`;
    }
    if (store) {
      url += `?store=${encodeURIComponent(store)}`;
    }

    const response = await this.send(url, { method: 'DELETE', headers: this.getHeaders() });

    if (response.statusCode !== 204) {
      await this.fail('delete context', response);
    }
  }

  async triggerInject(nodeId: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/inject/${encodeURIComponent(nodeId)}`, {
      method: 'POST',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 200) {
      await this.fail('trigger inject node', response);
    }
  }

  async setDebugNodeState(nodeId: string, enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    const response = await this.send(
      `${this.baseUrl}/debug/${encodeURIComponent(nodeId)}/${action}`,
      { method: 'POST', headers: this.getHeaders() }
    );

    // enable returns 200, disable returns 201
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      await this.fail(`${action} debug node`, response);
    }
  }

  /**
   * The installed node sets. GET /nodes answers with one flat entry per set, not per module.
   *
   * With `cached` the list is only fetched when nothing recent is held, which is what a type
   * lookup wants; without it the request is always made and the cache refreshed, so get_nodes
   * stays the way to see what Node-RED has right now.
   */
  async getNodes(options?: { cached?: boolean }): Promise<NodeSet[]> {
    if (options?.cached) {
      const cached = this.cache.nodeSets;
      if (cached && Date.now() - cached.fetchedAt < NODE_SET_CACHE_TTL_MS) {
        return cached.sets;
      }

      // Two lookups at the same time should share one request rather than race each other.
      if (this.cache.pending) {
        return await this.cache.pending;
      }
    }

    const pending = this.fetchNodeSets();
    this.cache.pending = pending;
    try {
      return await pending;
    } finally {
      // A failed fetch must not stay behind as the in-flight request, or every later caller
      // waits on a promise that is already rejected.
      if (this.cache.pending === pending) {
        this.cache.pending = undefined;
      }
    }
  }

  private async fetchNodeSets(): Promise<NodeSet[]> {
    const headers = this.getHeaders();
    headers.Accept = 'application/json';
    const response = await this.send(`${this.baseUrl}/nodes`, { method: 'GET', headers });

    if (response.statusCode !== 200) {
      await this.fail('get nodes', response);
    }

    const sets = z.array(NodeSetSchema).parse(await response.body.json());
    this.cache.nodeSets = { sets, fetchedAt: Date.now() };
    return sets;
  }

  /** Installing, removing or disabling a module changes which types exist. */
  private invalidateNodeSets(): void {
    this.cache.nodeSets = undefined;
    this.cache.pending = undefined;
  }

  /**
   * Fetch the editor config HTML for a node set: the node's own .html file (edit dialog plus
   * editor JavaScript) with the localised help appended. Callers that only want the help
   * should run it through extractNodeHelp.
   */
  async getNodeConfig(module: string, set: string): Promise<string> {
    const headers = this.getHeaders();
    headers.Accept = 'text/html';
    const response = await this.send(
      `${this.baseUrl}/nodes/${encodeNodePath(module)}/${encodeNodePath(set)}`,
      { method: 'GET', headers }
    );

    if (response.statusCode !== 200) {
      await this.fail('get node config', response);
    }

    return await response.body.text();
  }

  async installNode(module: string): Promise<NodeModule> {
    const response = await this.send(`${this.baseUrl}/nodes`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ module }),
      headersTimeout: INSTALL_TIMEOUT_MS,
      bodyTimeout: INSTALL_TIMEOUT_MS,
    });

    if (response.statusCode !== 200) {
      await this.fail('install node module', response);
    }

    this.invalidateNodeSets();
    const data = await response.body.json();
    return NodeModuleSchema.parse(data);
  }

  async setNodeModuleState(module: string, enabled: boolean): Promise<NodeModule> {
    const response = await this.send(`${this.baseUrl}/nodes/${encodeNodePath(module)}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify({ enabled }),
    });

    if (response.statusCode !== 200) {
      await this.fail('set node module state', response);
    }

    this.invalidateNodeSets();
    const data = await response.body.json();
    return NodeModuleSchema.parse(data);
  }

  async removeNodeModule(module: string): Promise<void> {
    const response = await this.send(`${this.baseUrl}/nodes/${encodeNodePath(module)}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (response.statusCode !== 204) {
      await this.fail('remove node module', response);
    }

    this.invalidateNodeSets();
  }
}
