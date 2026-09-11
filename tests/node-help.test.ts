import { describe, expect, it } from 'vitest';
import { extractNodeHelp } from '../src/node-help.js';

describe('extractNodeHelp', () => {
  it('should extract a single help block', () => {
    const html = `<!-- --- [red-module:node-red/inject] --- -->
<script type="text/html" data-template-name="inject"><input id="node-input-name"></script>
<script type="text/javascript">RED.nodes.registerType('inject', {});</script>
<script type="text/html" data-help-name="inject">
<p>Injects a message into a flow.</p>
</script>`;

    expect(extractNodeHelp(html)).toEqual([
      { type: 'inject', help: '<p>Injects a message into a flow.</p>' },
    ]);
  });

  it('should extract every help block in a set', () => {
    const html = `<script type="text/html" data-help-name="mqtt in"><p>Subscribes.</p></script>
<script type="text/html" data-help-name="mqtt out"><p>Publishes.</p></script>`;

    expect(extractNodeHelp(html).map((b) => b.type)).toEqual(['mqtt in', 'mqtt out']);
  });

  it('should handle single quotes and reversed attribute order', () => {
    const html = `<script data-help-name='foo-node' type='text/x-red'><p>Help.</p></script>`;

    expect(extractNodeHelp(html)).toEqual([{ type: 'foo-node', help: '<p>Help.</p>' }]);
  });

  it('should not treat the edit template as help', () => {
    const html = `<script type="text/html" data-template-name="inject"><p>Not help.</p></script>`;

    expect(extractNodeHelp(html)).toEqual([]);
  });

  it('should return an empty list when there is no help', () => {
    expect(extractNodeHelp('<script type="text/javascript">var a = 1;</script>')).toEqual([]);
  });
});
