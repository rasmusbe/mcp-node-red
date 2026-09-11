import { request } from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeRedClient } from '../src/client.js';
import type { Config } from '../src/schemas.js';

vi.mock('undici');

describe('NodeRedClient - Runtime Info', () => {
  let client: NodeRedClient;
  const mockConfig: Config = {
    nodeRedUrl: 'http://localhost:1880',
    nodeRedToken: 'test-token',
  };

  beforeEach(() => {
    client = new NodeRedClient(mockConfig);
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('should fetch settings successfully', async () => {
      const mockSettings = {
        httpNodeRoot: '/',
        version: '3.1.0',
        user: { username: 'admin', permissions: '*' },
        editorTheme: { projects: { enabled: true } },
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(mockSettings), text: vi.fn() },
      } as any);

      const result = await client.getSettings();
      expect(result).toEqual(mockSettings);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/settings', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 500,
        body: { text: vi.fn().mockResolvedValue('Internal Server Error') },
      } as any);
      await expect(client.getSettings()).rejects.toThrow('Failed to get settings: 500');
    });

    it('should handle settings without optional fields', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue({}), text: vi.fn() },
      } as any);
      const result = await client.getSettings();
      expect(result).toEqual({});
    });
  });

  describe('getDiagnostics', () => {
    it('should fetch diagnostics successfully', async () => {
      const mockDiagnostics = {
        report: 'diagnostics',
        scope: 'admin',
        nodejs: { version: 'v20.10.0' },
        os: { type: 'Linux', release: '6.1.0' },
        runtime: { version: '3.1.0' },
        modules: {},
        settings: {},
      };

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(mockDiagnostics), text: vi.fn() },
      } as any);

      const result = await client.getDiagnostics();
      expect(result).toEqual(mockDiagnostics);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/diagnostics', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
        },
      });
    });

    it('should throw error on failed request', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 403,
        body: { text: vi.fn().mockResolvedValue('Forbidden') },
      } as any);
      await expect(client.getDiagnostics()).rejects.toThrow('Failed to get diagnostics: 403');
    });

    it('should handle diagnostics with extra fields', async () => {
      const diagnosticsWithExtras = { report: 'diagnostics', customField: 'extra data' };
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { json: vi.fn().mockResolvedValue(diagnosticsWithExtras), text: vi.fn() },
      } as any);
      const result = await client.getDiagnostics();
      expect(result).toEqual(diagnosticsWithExtras);
    });
  });
  describe('getNodeConfig', () => {
    it('should fetch node config HTML with the text/html accept header', async () => {
      const mockHtml = '<script type="text/html" data-help-name="inject"><p>Help.</p></script>';

      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { text: vi.fn().mockResolvedValue(mockHtml) },
      } as any);

      const result = await client.getNodeConfig('node-red', 'inject');
      expect(result).toBe(mockHtml);
      expect(request).toHaveBeenCalledWith('http://localhost:1880/nodes/node-red/inject', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Node-RED-API-Version': 'v2',
          Authorization: 'Bearer test-token',
          Accept: 'text/html',
        },
      });
    });

    it('should keep the scope separator of a scoped module as a literal slash', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { text: vi.fn().mockResolvedValue('') },
      } as any);

      await client.getNodeConfig('@scope/node-red-contrib-foo', 'foo-node');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/nodes/@scope/node-red-contrib-foo/foo-node',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should percent-encode characters that would break the path', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 200,
        body: { text: vi.fn().mockResolvedValue('') },
      } as any);

      await client.getNodeConfig('node-red', 'weird?set#name');
      expect(request).toHaveBeenCalledWith(
        'http://localhost:1880/nodes/node-red/weird%3Fset%23name',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should throw error on 404', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 404,
        body: { text: vi.fn().mockResolvedValue('Not Found') },
      } as any);
      await expect(client.getNodeConfig('nonexistent', 'nonexistent')).rejects.toThrow(
        'Failed to get node config: 404'
      );
    });

    it('should throw error on 401', async () => {
      vi.mocked(request).mockResolvedValue({
        statusCode: 401,
        body: { text: vi.fn().mockResolvedValue('Unauthorized') },
      } as any);
      await expect(client.getNodeConfig('node-red', 'inject')).rejects.toThrow(
        'Failed to get node config: 401'
      );
    });
  });
});
