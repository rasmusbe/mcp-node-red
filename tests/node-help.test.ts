import { describe, expect, it } from 'vitest';
import { extractNodeArguments, extractNodeHelp } from '../src/node-help.js';

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

describe('extractNodeArguments', () => {
  it('should read fields from the edit dialog by their node-input id', () => {
    const html = `<script type="text/html" data-template-name="inject">
<div class="form-row">
  <label for="node-input-name">Name</label>
  <input type="text" id="node-input-name" placeholder="Name">
</div>
<div class="form-row">
  <label for="node-input-once">Inject once</label>
  <input type="checkbox" id="node-input-once">
</div>
</script>`;

    expect(extractNodeArguments(html).get('inject')).toEqual([
      { name: 'name', inputType: 'text', label: 'Name', placeholder: 'Name' },
      { name: 'once', inputType: 'checkbox', label: 'Inject once' },
    ]);
  });

  it('should list the allowed values of a select', () => {
    const html = `<script type="text/html" data-template-name="mqtt in">
<select id="node-input-qos">
  <option value="0">0</option>
  <option value="1">1</option>
  <option value="2">2</option>
</select>
<input type="text" id="node-input-topic">
</script>`;

    expect(extractNodeArguments(html).get('mqtt in')).toEqual([
      { name: 'qos', inputType: 'select', options: ['0', '1', '2'] },
      { name: 'topic', inputType: 'text' },
    ]);
  });

  it('should read config node fields', () => {
    const html = `<script type="text/html" data-template-name="mqtt-broker">
<input type="text" id="node-config-input-broker">
</script>`;

    expect(extractNodeArguments(html).get('mqtt-broker')).toEqual([
      { name: 'broker', inputType: 'text' },
    ]);
  });

  it('should ignore inputs that are not node properties', () => {
    const html = `<script type="text/html" data-template-name="inject">
<input type="text" id="some-search-box">
<input type="text" id="node-input-topic">
</script>`;

    expect(extractNodeArguments(html).get('inject')).toEqual([
      { name: 'topic', inputType: 'text' },
    ]);
  });

  it('should find fields regardless of how deeply the markup nests them', () => {
    const html = `<script type="text/html" data-template-name="mqtt in">
<div class="form-row"><div class="flags"><div class="flag">
  <label for="node-input-rap"><input type="checkbox" id="node-input-rap"><span>Retain</span></label>
</div></div></div>
</script>`;

    expect(extractNodeArguments(html).get('mqtt in')).toEqual([
      { name: 'rap', inputType: 'checkbox', label: 'Retain' },
    ]);
  });

  it('should drop a label that several fields claim', () => {
    const html = `<script type="text/html" data-template-name="mqtt in">
<label for="node-input-nl">Flags</label>
<div><label for="node-input-nl"><input type="checkbox" id="node-input-nl"><span></span></label></div>
</script>`;

    expect(extractNodeArguments(html).get('mqtt in')).toEqual([
      { name: 'nl', inputType: 'checkbox' },
    ]);
  });

  it('should keep each node type separate', () => {
    const html = `<script type="text/html" data-template-name="mqtt in"><input type="text" id="node-input-topic"></script>
<script type="text/html" data-template-name="mqtt out"><input type="text" id="node-input-retain"></script>`;

    const result = extractNodeArguments(html);
    expect([...result.keys()]).toEqual(['mqtt in', 'mqtt out']);
    expect(result.get('mqtt out')).toEqual([{ name: 'retain', inputType: 'text' }]);
  });

  it('should return an empty map when there is no edit dialog', () => {
    expect(extractNodeArguments('<script type="text/javascript">var a = 1;</script>').size).toBe(0);
  });
});
