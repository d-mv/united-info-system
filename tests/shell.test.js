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

test('core/theme.css exists and defines theme tokens and typography rules', () => {
  const themePath = path.resolve('core/theme.css');
  assert.ok(fs.existsSync(themePath), 'core/theme.css must exist');

  const content = fs.readFileSync(themePath, 'utf-8');
  assert.ok(content.includes('--color-canvas'), 'Must define --color-canvas');
  assert.ok(content.includes('--color-ink'), 'Must define --color-ink');
  assert.ok(content.includes('--color-accent'), 'Must define --color-accent');
  assert.ok(content.includes('--font-sans'), 'Must define --font-sans');
  assert.ok(content.includes('--font-mono'), 'Must define --font-mono');
  assert.ok(content.includes('font-family: "Space Grotesk"') && content.includes('space-grotesk-latin'), 'Must self-host Space Grotesk via @font-face');
  assert.ok(content.includes('font-family: "IBM Plex Mono"') && content.includes('ibm-plex-mono-latin'), 'Must self-host IBM Plex Mono via @font-face');
  assert.ok(content.includes('font-size: 62.5%'), 'Must set font-size: 62.5% on html');
  assert.ok(content.includes('font-family: var(--font-sans)'), 'Must use font-sans for base styling');
  assert.ok(content.includes('widget-clock') && content.includes('font-family: var(--font-mono)'), 'Clock must use font-mono');
});
