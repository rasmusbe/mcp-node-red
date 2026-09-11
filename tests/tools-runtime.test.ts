import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeRedClient } from '../src/client.js';
import { getDiagnostics } from '../src/tools/get-diagnostics.js';
import { getNodeHelp } from '../src/tools/get-node-help.js';
import { getSettings } from '../src/tools/get-settings.js';

describe('Runtime Info Tool Handlers', () => {
  let mockClient: NodeRedClient;

  beforeEach(() => {
    mockClient = {
      getSettings: vi.fn(),
      getDiagnostics: vi.fn(),
      getNodeConfig: vi.fn(),
      getNodes: vi.fn(),
    } as any;
  });

  describe('getSettings', () => {
    it('should return formatted settings', async () => {
      const mockSettingsData = {
        httpNodeRoot: '/',
        version: '3.1.0',
        user: { username: 'admin', permissions: '*' },
      };
      vi.mocked(mockClient.getSettings).mockResolvedValue(mockSettingsData);
      const result = await getSettings(mockClient);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(mockSettingsData);
    });

    it('should handle empty settings', async () => {
      vi.mocked(mockClient.getSettings).mockResolvedValue({});
      const result = await getSettings(mockClient);
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual({});
    });
  });

  describe('getDiagnostics', () => {
    it('should return formatted diagnostics', async () => {
      const mockDiagnosticsData = {
        report: 'diagnostics',
        scope: 'admin',
        nodejs: { version: 'v20.10.0' },
        os: { type: 'Linux' },
      };
      vi.mocked(mockClient.getDiagnostics).mockResolvedValue(mockDiagnosticsData);
      const result = await getDiagnostics(mockClient);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(JSON.parse(result.content[0].text)).toEqual(mockDiagnosticsData);
    });

    it('should handle minimal diagnostics', async () => {
      vi.mocked(mockClient.getDiagnostics).mockResolvedValue({});
      const result = await getDiagnostics(mockClient);
      expect(result.content).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toEqual({});
    });
  });
  describe('getNodeHelp', () => {
    const injectConfig = `<!-- --- [red-module:node-red/inject] --- -->
<script type="text/html" data-template-name="inject"><input id="node-input-name"></script>
<script type="text/javascript">RED.nodes.registerType('inject', {});</script>
<script type="text/html" data-help-name="inject"><p>Injects a message into a flow.</p></script>`;

    it('should return only the help section for a module and set', async () => {
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(injectConfig);

      const result = await getNodeHelp(mockClient, { module: 'node-red', set: 'inject' });
      expect(mockClient.getNodeConfig).toHaveBeenCalledWith('node-red', 'inject');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toBe(
        [
          '## inject',
          '',
          '<p>Injects a message into a flow.</p>',
          '',
          '### Configurable properties',
          '',
          '- `name` (text)',
        ].join('\n')
      );
      expect(result.content[0].text).not.toContain('registerType');
    });

    it('should resolve a node type to its module and set', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        { id: 'node-red/common', name: 'common', version: '4.1.5', types: ['comment'] },
        { id: 'node-red/inject', name: 'inject', version: '4.1.5', types: ['inject'] },
      ] as any);
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(injectConfig);

      const result = await getNodeHelp(mockClient, { type: 'inject' });
      expect(mockClient.getNodes).toHaveBeenCalledWith({ cached: true });
      expect(mockClient.getNodeConfig).toHaveBeenCalledWith('node-red', 'inject');
      expect(result.content[0].text).toContain('Injects a message into a flow.');
    });

    it('should ask for a fresh node list when the cached one does not know the type', async () => {
      vi.mocked(mockClient.getNodes)
        .mockResolvedValueOnce([] as any)
        .mockResolvedValueOnce([
          { id: 'node-red/inject', name: 'inject', version: '4.1.5', types: ['inject'] },
        ] as any);
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(injectConfig);

      await getNodeHelp(mockClient, { type: 'inject' });

      expect(mockClient.getNodes).toHaveBeenNthCalledWith(1, { cached: true });
      expect(mockClient.getNodes).toHaveBeenNthCalledWith(2);
      expect(mockClient.getNodeConfig).toHaveBeenCalledWith('node-red', 'inject');
    });

    it('should resolve a scoped module id on the last slash', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        {
          id: '@scope/node-red-contrib-foo/foo-node',
          name: 'foo-node',
          version: '1.0.0',
          types: ['foo'],
        },
      ] as any);
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue('');

      await getNodeHelp(mockClient, { type: 'foo' });
      expect(mockClient.getNodeConfig).toHaveBeenCalledWith(
        '@scope/node-red-contrib-foo',
        'foo-node'
      );
    });

    it('should keep only the requested type when a set registers several', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        { id: 'node-red/mqtt', name: 'mqtt', version: '4.1.5', types: ['mqtt in', 'mqtt out'] },
      ] as any);
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(
        `<script type="text/html" data-help-name="mqtt in"><p>Subscribes.</p></script>
<script type="text/html" data-help-name="mqtt out"><p>Publishes.</p></script>`
      );

      const result = await getNodeHelp(mockClient, { type: 'mqtt in' });
      expect(result.content[0].text).toBe('## mqtt in\n\n<p>Subscribes.</p>');
    });

    it('should return every help block when addressed by module and set', async () => {
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(
        `<script type="text/html" data-help-name="mqtt in"><p>Subscribes.</p></script>
<script type="text/html" data-help-name="mqtt out"><p>Publishes.</p></script>`
      );

      const result = await getNodeHelp(mockClient, { module: 'node-red', set: 'mqtt' });
      expect(result.content[0].text).toContain('## mqtt in');
      expect(result.content[0].text).toContain('## mqtt out');
    });

    it('should return the full config when raw is set', async () => {
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue(injectConfig);

      const result = await getNodeHelp(mockClient, {
        module: 'node-red',
        set: 'inject',
        raw: true,
      });
      expect(result.content[0].text).toBe(injectConfig);
    });

    it('should fall back to the raw config when there is no help section', async () => {
      vi.mocked(mockClient.getNodeConfig).mockResolvedValue('<script>var a = 1;</script>');

      const result = await getNodeHelp(mockClient, { module: 'node-red', set: 'inject' });
      expect(result.content[0].text).toContain('No help section found for node-red/inject');
      expect(result.content[0].text).toContain('var a = 1;');
    });

    it('should throw when no installed set registers the type', async () => {
      vi.mocked(mockClient.getNodes).mockResolvedValue([
        { id: 'node-red/inject', name: 'inject', version: '4.1.5', types: ['inject'] },
      ] as any);

      await expect(getNodeHelp(mockClient, { type: 'nope' })).rejects.toThrow(
        'No installed node set registers the type "nope"'
      );
      expect(mockClient.getNodeConfig).not.toHaveBeenCalled();
    });

    it('should reject invalid arguments', async () => {
      await expect(getNodeHelp(mockClient, {})).rejects.toThrow();
      await expect(getNodeHelp(mockClient, { module: 'node-red' })).rejects.toThrow();
      await expect(getNodeHelp(mockClient, { set: 'inject' })).rejects.toThrow();
      await expect(getNodeHelp(mockClient, { type: 42 })).rejects.toThrow();
    });
  });
});
