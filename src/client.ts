import { Agent, request } from 'undici';
import { z } from 'zod';
import type {
  Config,
  CreateFlowRequest,
  FlowState,
  NodeModule,
  NodeRedDiagnostics,
  NodeRedFlowsResponse,
  NodeRedGlobalFlowResponse,
  NodeRedSettings,
  UpdateFlowRequest,
} from './schemas.js';
import {
  FlowStateSchema,
  NodeModuleSchema,
  NodeRedDiagnosticsSchema,
  NodeRedFlowsResponseSchema,
  NodeRedGlobalFlowResponseSchema,
  NodeRedSettingsSchema,
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

export class NodeRedClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly basicAuth?: string;
  private readonly signal?: AbortSignal;

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

  private options(init: HttpRequestOptions): HttpRequestOptions {
    return { ...init, dispatcher: nodeRedAgent, signal: this.signal };
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
    const response = await request(
      `${this.baseUrl}/flows`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('get flows', response);
    }

    const data = await response.body.json();
    return NodeRedFlowsResponseSchema.parse(data);
  }

  async createFlow(flowData: CreateFlowRequest): Promise<{ id: string }> {
    const response = await request(
      `${this.baseUrl}/flow`,
      this.options({
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(flowData),
      })
    );

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
    const response = await request(
      `${this.baseUrl}/flow/${encodeFlowId(flowId)}`,
      this.options({
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(flowData),
      })
    );

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
    const response = await request(
      `${this.baseUrl}/flow/${encodeFlowId(flowId)}`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('get flow', response);
    }

    return await response.body.json();
  }

  async getGlobalFlow(): Promise<NodeRedGlobalFlowResponse> {
    const response = await request(
      `${this.baseUrl}/flow/global`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('get global flow', response);
    }

    const data = await response.body.json();
    return NodeRedGlobalFlowResponseSchema.parse(data);
  }

  async updateGlobalFlow(flowData: NodeRedGlobalFlowResponse): Promise<{ id: string }> {
    const response = await request(
      `${this.baseUrl}/flow/global`,
      this.options({
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(flowData),
      })
    );

    if (response.statusCode !== 200 && response.statusCode !== 204) {
      await this.fail('update global flow', response);
    }

    if (response.statusCode === 204) {
      return { id: 'global' };
    }
    const data = await response.body.json();
    return data as { id: string };
  }

  async deleteFlow(flowId: string): Promise<void> {
    const response = await request(
      `${this.baseUrl}/flow/${encodeFlowId(flowId)}`,
      this.options({ method: 'DELETE', headers: this.getHeaders() })
    );

    if (response.statusCode !== 204) {
      await this.fail('delete flow', response);
    }
  }

  async getFlowState(): Promise<FlowState> {
    const response = await request(
      `${this.baseUrl}/flows/state`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('get flow state', response);
    }

    const data = await response.body.json();
    return FlowStateSchema.parse(data);
  }

  async setFlowState(state: 'start' | 'stop'): Promise<FlowState> {
    const response = await request(
      `${this.baseUrl}/flows/state`,
      this.options({
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ state }),
      })
    );

    if (response.statusCode !== 200) {
      await this.fail('set flow state', response);
    }

    const data = await response.body.json();
    return FlowStateSchema.parse(data);
  }

  async getSettings(): Promise<NodeRedSettings> {
    const response = await request(
      `${this.baseUrl}/settings`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('get settings', response);
    }

    const data = await response.body.json();
    return NodeRedSettingsSchema.parse(data);
  }

  async getDiagnostics(): Promise<NodeRedDiagnostics> {
    const response = await request(
      `${this.baseUrl}/diagnostics`,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

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

    const response = await request(
      url,
      this.options({ method: 'GET', headers: this.getHeaders() })
    );

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

    const response = await request(
      url,
      this.options({ method: 'DELETE', headers: this.getHeaders() })
    );

    if (response.statusCode !== 204) {
      await this.fail('delete context', response);
    }
  }

  async triggerInject(nodeId: string): Promise<void> {
    const response = await request(
      `${this.baseUrl}/inject/${encodeURIComponent(nodeId)}`,
      this.options({ method: 'POST', headers: this.getHeaders() })
    );

    if (response.statusCode !== 200) {
      await this.fail('trigger inject node', response);
    }
  }

  async setDebugNodeState(nodeId: string, enabled: boolean): Promise<void> {
    const action = enabled ? 'enable' : 'disable';
    const response = await request(
      `${this.baseUrl}/debug/${encodeURIComponent(nodeId)}/${action}`,
      this.options({ method: 'POST', headers: this.getHeaders() })
    );

    // enable returns 200, disable returns 201
    if (response.statusCode !== 200 && response.statusCode !== 201) {
      await this.fail(`${action} debug node`, response);
    }
  }

  async validateFlow(flowData: UpdateFlowRequest): Promise<{ valid: boolean; errors?: string[] }> {
    try {
      const errors: string[] = [];

      if (!flowData.id) {
        errors.push('Flow missing required id field');
      }

      if (flowData.nodes) {
        for (const node of flowData.nodes) {
          if (!node.id) {
            errors.push('Node missing required id field');
          }
          if (!node.type) {
            errors.push(`Node ${node.id} missing required type field`);
          }
        }
      }

      if (flowData.configs) {
        for (const config of flowData.configs) {
          if (!config.id) {
            errors.push('Config node missing required id field');
          }
          if (!config.type) {
            errors.push(`Config node ${config.id} missing required type field`);
          }
        }
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  async getNodes(): Promise<NodeModule[]> {
    const headers = this.getHeaders();
    headers.Accept = 'application/json';
    const response = await request(
      `${this.baseUrl}/nodes`,
      this.options({ method: 'GET', headers })
    );

    if (response.statusCode !== 200) {
      await this.fail('get nodes', response);
    }

    const data = await response.body.json();
    return z.array(NodeModuleSchema).parse(data);
  }

  /**
   * Fetch the editor config HTML for a node set: the node's own .html file (edit dialog plus
   * editor JavaScript) with the localised help appended. Callers that only want the help
   * should run it through extractNodeHelp.
   */
  async getNodeConfig(module: string, set: string): Promise<string> {
    const headers = this.getHeaders();
    headers.Accept = 'text/html';
    const response = await request(
      `${this.baseUrl}/nodes/${encodeNodePath(module)}/${encodeNodePath(set)}`,
      this.options({ method: 'GET', headers })
    );

    if (response.statusCode !== 200) {
      await this.fail('get node config', response);
    }

    return await response.body.text();
  }

  async installNode(module: string): Promise<NodeModule> {
    const response = await request(
      `${this.baseUrl}/nodes`,
      this.options({
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ module }),
        headersTimeout: INSTALL_TIMEOUT_MS,
        bodyTimeout: INSTALL_TIMEOUT_MS,
      })
    );

    if (response.statusCode !== 200) {
      await this.fail('install node module', response);
    }

    const data = await response.body.json();
    return NodeModuleSchema.parse(data);
  }

  async setNodeModuleState(module: string, enabled: boolean): Promise<NodeModule> {
    const response = await request(
      `${this.baseUrl}/nodes/${encodeNodePath(module)}`,
      this.options({
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify({ enabled }),
      })
    );

    if (response.statusCode !== 200) {
      await this.fail('set node module state', response);
    }

    const data = await response.body.json();
    return NodeModuleSchema.parse(data);
  }

  async removeNodeModule(module: string): Promise<void> {
    const response = await request(
      `${this.baseUrl}/nodes/${encodeNodePath(module)}`,
      this.options({ method: 'DELETE', headers: this.getHeaders() })
    );

    if (response.statusCode !== 204) {
      await this.fail('remove node module', response);
    }
  }
}
