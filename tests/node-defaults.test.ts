import { describe, expect, it } from 'vitest';
import { extractNodeDefaults } from '../src/node-defaults.js';

const injectConfig = `<script type="text/html" data-template-name="inject">
<input type="text" id="node-input-name">
</script>
<script type="text/javascript">
  RED.nodes.registerType('inject', {
    category: 'common',
    // The server the node talks to.
    defaults: {
      server: { value: '', type: 'server', required: true },
      name: { value: '' },
      topic: { value: 'ping', validate: RED.validators.number() },
      repeat: { value: 0 },
      once: { value: false },
      onceDelay: { value: 0.1 },
      entityId: { value: [] },
      outputProperties: {
        value: [{ property: 'topic', propertyType: 'msg', value: 'topic', valueType: 'msg' }],
      },
      label: { value: RED._('node-red:inject.label') },
      note: { value: \`a \${x} b\` },
      cron: {
        value: '',
        validate: function (v) { return v !== ''; },
      },
    },
    credentials: {
      password: { type: 'password' },
      user: { type: 'text' },
    },
    inputs: 1,
  });
</script>`;

describe('extractNodeDefaults', () => {
  it('should read the properties a node registers', () => {
    const defaults = extractNodeDefaults(injectConfig).get('inject');

    expect(defaults?.properties).toEqual([
      { name: 'server', value: '', type: 'server', required: true },
      { name: 'name', value: '' },
      { name: 'topic', value: 'ping' },
      { name: 'repeat', value: 0 },
      { name: 'once', value: false },
      { name: 'onceDelay', value: 0.1 },
      { name: 'entityId', value: [] },
      {
        name: 'outputProperties',
        value: [{ property: 'topic', propertyType: 'msg', value: 'topic', valueType: 'msg' }],
      },
      { name: 'label', value: undefined },
      { name: 'note', value: undefined },
      { name: 'cron', value: '' },
    ]);
  });

  it('should read the credentials a node registers', () => {
    expect(extractNodeDefaults(injectConfig).get('inject')?.credentials).toEqual([
      { name: 'password', type: 'password' },
      { name: 'user', type: 'text' },
    ]);
  });

  it('should read every registration in one script block', () => {
    const html = `<script type="text/javascript">
      RED.nodes.registerType("mqtt in", { defaults: { topic: { value: "" } } });
      RED.nodes.registerType("mqtt out", { defaults: { retain: { value: true } } });
    </script>`;

    const defaults = extractNodeDefaults(html);
    expect([...defaults.keys()]).toEqual(['mqtt in', 'mqtt out']);
    expect(defaults.get('mqtt out')?.properties).toEqual([{ name: 'retain', value: true }]);
  });

  it('should read a registration in an untyped or module script', () => {
    const html = `<script>RED.nodes.registerType('a', { defaults: { x: { value: 1 } } });</script>
<script type="text/module">RED.nodes.registerType('b', { defaults: { y: { value: 2 } } });</script>`;

    expect([...extractNodeDefaults(html).keys()]).toEqual(['a', 'b']);
  });

  it('should ignore a registration with neither defaults nor credentials', () => {
    const html = `<script type="text/javascript">RED.nodes.registerType('inject', {});</script>`;

    expect(extractNodeDefaults(html).size).toBe(0);
  });

  it('should keep an explicitly empty defaults object', () => {
    const html = `<script type="text/javascript">RED.nodes.registerType('c', { defaults: {} });</script>`;

    expect(extractNodeDefaults(html).get('c')).toEqual({ properties: [], credentials: [] });
  });

  it('should not be confused by braces inside strings, comments or regular expressions', () => {
    const html = `<script type="text/javascript">
      RED.nodes.registerType('tricky', {
        oneditprepare: function () {
          var pattern = /[{},]/g;      // }, in a regular expression
          var text = "a } b , c";      /* } in a comment */
          $('#node-input-x').val(text.replace(pattern, '{'));
        },
        defaults: {
          x: { value: '}' },
          y: { value: "a,b" },
        },
      });
    </script>`;

    expect(extractNodeDefaults(html).get('tricky')?.properties).toEqual([
      { name: 'x', value: '}' },
      { name: 'y', value: 'a,b' },
    ]);
  });

  it('should skip a value that is an expression rather than a literal', () => {
    const html = `<script type="text/javascript">
      RED.nodes.registerType('e', {
        defaults: {
          a: { value: 1 + 2 },
          b: { value: someDefault },
          c: { value: (function () { return 3; })() },
          d: { value: 'kept' },
        },
      });
    </script>`;

    expect(extractNodeDefaults(html).get('e')?.properties).toEqual([
      { name: 'a', value: undefined },
      { name: 'b', value: undefined },
      { name: 'c', value: undefined },
      { name: 'd', value: 'kept' },
    ]);
  });

  it('should ignore registerType inside the help and the edit dialog', () => {
    const html = `<script type="text/html" data-help-name="inject">
<p>Call RED.nodes.registerType('fake', { defaults: { x: { value: 1 } } }) to register.</p>
</script>`;

    expect(extractNodeDefaults(html).size).toBe(0);
  });

  it('should return an empty map when there is no registration', () => {
    expect(extractNodeDefaults('<script>var a = 1;</script>').size).toBe(0);
  });
});
