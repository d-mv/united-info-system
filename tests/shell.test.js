import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('index.html exists and contains critical shell structure', () => {
  const indexPath = path.resolve('index.html');
  assert.ok(fs.existsSync(indexPath), 'index.html must exist');

  const content = fs.readFileSync(indexPath, 'utf-8');
  assert.ok(content.includes('<div id="shell"></div>'), 'Must contain #shell element');
  assert.ok(content.includes('prefers-color-scheme: dark'), 'Must contain dark theme media query in critical CSS');
  assert.ok(content.includes('type="module"'), 'Must load core module script');
});

test('core/theme.css exists and defines theme tokens', () => {
  const themePath = path.resolve('core/theme.css');
  assert.ok(fs.existsSync(themePath), 'core/theme.css must exist');

  const content = fs.readFileSync(themePath, 'utf-8');
  assert.ok(content.includes('--color-bg'), 'Must define --color-bg');
  assert.ok(content.includes('--color-accent'), 'Must define --color-accent');
});
