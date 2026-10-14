// Shared-layer gate: copies = MCP server, notes.<lang>.json = registry pick; the JS layer contains nothing that the n8n
// linter (TypeScript only) would miss but the verification scanner would not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diff, sourceAvailable, SHARED, FILES } from '../scripts/sync-shared.mjs';

const RESTRICTED = /\b(globalThis|process|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|__dirname|__filename|console|require)\b/;
const IMPORT = /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm;

/** @param {string} src */
function violations(src) {
	const out = [];
	const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const m = RESTRICTED.exec(code);
	if (m) out.push('global ' + m[1]);
	for (const [, spec] of code.matchAll(IMPORT)) if (!spec.startsWith('./')) out.push('import ' + spec);
	return out;
}

test('shared — copies match mcp-server/src, hint pick matches the registry', { skip: !sourceAvailable() && 'source absent (outside the plugin repository)' }, () => {
	assert.deepEqual(diff(), []);
});

test('shared — the JS layer has no forbidden globals and external imports', () => {
	for (const f of FILES) assert.deepEqual(violations(fs.readFileSync(path.join(SHARED, f), 'utf8')), [], f);
});

test('shared — the detector can actually fail', () => {
	assert.deepEqual(violations('export const a = () => setTimeout(() => {}, 1);'), ['global setTimeout']);
	assert.deepEqual(violations("import x from 'node:fs';\nexport default x;"), ['import node:fs']);
	assert.deepEqual(violations('// globalThis in a comment\nexport const b = 1;'), []);
});
