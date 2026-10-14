#!/usr/bin/env node
// Manual run of the n8n source scanner (the same one used for package verification) — before submitting for verification.
// The scanner is not a package dependency. Prepare it in a temp folder:
//   npm i --prefix <folder> --ignore-scripts @n8n/scan-community-package typescript@5.9.2 n8n-workflow
// (typescript is pinned: 7.x breaks @typescript-eslint/parser). Run:
//   SCANNER_DIR=<folder> node tests/scan-source.mjs
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.env.SCANNER_DIR;
if (!dir) {
	console.error('scan-source: set SCANNER_DIR to the folder with @n8n/scan-community-package installed');
	process.exit(2);
}
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = pathToFileURL(path.join(path.resolve(dir), 'node_modules/@n8n/scan-community-package/scanner/scanner.mjs')).href;
const { analyzePackage, SOURCE_FILE_PATTERNS } = await import(scanner);
const res = await analyzePackage(PKG, SOURCE_FILE_PATTERNS);
if (!res.passed) {
	console.error('scan-source: ' + res.message + '\n' + (res.details ?? ''));
	process.exit(1);
}
console.log('scan-source: passed (' + SOURCE_FILE_PATTERNS.join(', ') + ')');
