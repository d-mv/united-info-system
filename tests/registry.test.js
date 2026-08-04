import { test } from 'node:test';
import assert from 'node:assert';
import { registry, loadModule, registerModule } from '../core/registry.js';

test('registry maps standard modules and allows custom registrations', () => {
  assert.ok(registry.clock);
  assert.ok(registry.weather);
  assert.ok(registry.bookmarks);
  assert.ok(registry.todo);

  registerModule('test-mod', { type: 'widget', load: async () => ({ loaded: true }) });
  assert.ok(registry['test-mod']);
});

test('loadModule returns isolated error result when import fails', async () => {
  registerModule('broken-mod', {
    type: 'widget',
    load: async () => {
      throw new Error('Module import error');
    }
  });

  const res = await loadModule('broken-mod');
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.id, 'broken-mod');
  assert.ok(res.error.message.includes('Module import error'));
});

test('loadModule returns success on valid module load', async () => {
  registerModule('valid-mod', {
    type: 'app',
    load: async () => ({ default: class ValidElement {} })
  });

  const res = await loadModule('valid-mod');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.id, 'valid-mod');
});
