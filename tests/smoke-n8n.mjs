#!/usr/bin/env node
// Node smoke against a local n8n stand and a YouTrack test stand (#113 1a, spec §9): the build goes to
// custom-nodes, credentials and a "Webhook → Code → node" workflow are created via the n8n public API, each step is a webhook call.
// Usage: node tests/smoke-n8n.mjs <projectKey> <issueId>   (run npm run build first)
// <projectKey> — a project with the planner (it also holds the <projectKey>-1 and -2 issues for releases); <issueId> — an issue for "Set field",
// may live in another project: field types are taken from the issue's own project.
// Environment (there are deliberately no defaults for the project, issue and Keychain names — same as the MCP server smoke):
//   N8N_URL            n8n URL, default http://localhost:5678
//   N8N_API_KEY | N8N_KEY_SERVICE [N8N_KEY_ACCOUNT=api-key]      n8n public API key (macOS Keychain)
//   N8N_CUSTOM_DIR     the stand's custom-nodes folder on the host (mounted at /home/node/.n8n/custom)
//   N8N_CONTAINER      the n8n container to restart (n8n sees a new credential type after a restart); empty — no restart
//   YT_URL             YouTrack for the node from inside the container, e.g. http://host.docker.internal:<port>
//   YT_HOST_URL        the same YouTrack from the host — checks and fixture preparation, e.g. http://localhost:<port>
//   YT_TOKEN | YT_TOKEN_SERVICE [YT_TOKEN_ACCOUNT=api-token]     test-stand token
// The script WRITES data and returns the state (workflow, credentials, field values and temporary bundle values);
// the safety guard allows only local addresses. Token values are never printed.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name: PKG_NAME } = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const { BRAND } = require(path.join(PKG, 'dist/nodes/SprintPlanner/branding.js'));

const [projectKey, issueId] = process.argv.slice(2);
if (!projectKey || !issueId) { console.error('usage: node tests/smoke-n8n.mjs <projectKey> <issueId>'); process.exit(2); }
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|[a-z0-9-]+\.orb\.local)(:\d+)?\/?$/;
const n8nUrl = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/+$/, '');
const ytUrl = (process.env.YT_URL || '').replace(/\/+$/, '');
const ytHost = (process.env.YT_HOST_URL || '').replace(/\/+$/, '');
for (const [n, u] of [['N8N_URL', n8nUrl], ['YT_URL', ytUrl], ['YT_HOST_URL', ytHost]]) {
	if (!LOCAL.test(u)) { console.error(`smoke: REFUSED — ${n} "${u}" is not local`); process.exit(2); }
}
if (!process.env.N8N_CUSTOM_DIR || !fs.existsSync(process.env.N8N_CUSTOM_DIR)) { console.error('smoke: N8N_CUSTOM_DIR required — the stand\'s custom-nodes folder'); process.exit(2); }
if (!fs.existsSync(path.join(PKG, 'dist/nodes/SprintPlanner/SprintPlanner.node.js'))) { console.error('smoke: no dist/ — run npm run build first'); process.exit(2); }

function secret(envValue, envService, account) {
	if (process.env[envValue]) return process.env[envValue];
	if (!process.env[envService]) { console.error(`smoke: ${envValue} or ${envService} (Keychain) required`); process.exit(2); }
	return execFileSync('security', ['find-generic-password', '-s', process.env[envService], '-a', account, '-w'], { encoding: 'utf8' }).trim();
}
const n8nKey = secret('N8N_API_KEY', 'N8N_KEY_SERVICE', process.env.N8N_KEY_ACCOUNT || 'api-key');
const ytToken = secret('YT_TOKEN', 'YT_TOKEN_SERVICE', process.env.YT_TOKEN_ACCOUNT || 'api-token');

const failed = [];
const check = (name, ok, detail = '') => {
	console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  → ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)));
	if (!ok) failed.push(name);
	return ok;
};

async function http(base, headers, method, p, body) {
	const res = await fetch(base + p, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
	const text = await res.text();
	let data;
	try { data = text ? JSON.parse(text) : null; } catch { data = text; }
	return { status: res.status, data };
}
const n8n = (m, p, b) => http(n8nUrl, { 'X-N8N-API-KEY': n8nKey }, m, '/api/v1' + p, b);
const yt = (m, p, b) => http(ytHost, { Authorization: 'Bearer ' + ytToken }, m, p, b);

// 1. Deploy the build and restart (a credential type registers only at n8n startup)
const target = path.join(process.env.N8N_CUSTOM_DIR, PKG_NAME);
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(path.join(PKG, 'dist'), target, { recursive: true });
if (process.env.N8N_CONTAINER) {
	execFileSync('docker', ['restart', process.env.N8N_CONTAINER], { stdio: 'ignore' });
	for (let i = 0; i < 60; i++) {
		if ((await fetch(n8nUrl + '/healthz').then((r) => r.ok).catch(() => false)) && (await n8n('GET', '/credentials/schema/' + BRAND.credentialName)).status === 200) break;
		await new Promise((r) => setTimeout(r, 2000));
	}
}
check('credential type visible to the public API', (await n8n('GET', '/credentials/schema/' + BRAND.credentialName)).status === 200);

const cred = await n8n('POST', '/credentials', { name: 'smoke-113-1a', type: BRAND.credentialName, data: { url: ytUrl, token: ytToken, appId: BRAND.appId } });
if (!check('credentials created', cred.status === 200 && cred.data?.id, cred.data)) process.exit(1);
const NODE_TYPE = 'CUSTOM.sprintPlanner';
const PR = { __rl: true, mode: 'key', value: projectKey };

/** One node run: a workflow is created, activated, called via webhook and deleted. */
async function node(parameters, { items, continueOnFail = false, credId = cred.data.id } = {}) {
	const hook = 'smoke-113-1a-' + randomUUID();
	const wf = await n8n('POST', '/workflows', {
		name: 'smoke-113-1a ' + parameters.resource + '.' + parameters.operation,
		nodes: [
			{ id: randomUUID(), name: 'Hook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: randomUUID(), parameters: { httpMethod: 'POST', path: hook, responseMode: 'lastNode', responseData: 'allEntries', options: {} } },
			{ id: randomUUID(), name: 'Items', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0], parameters: { jsCode: 'return ($input.first().json.body.items || [{}]).map((json) => ({ json }));' } },
			{
				id: randomUUID(), name: 'Planner', type: NODE_TYPE, typeVersion: 1, position: [440, 0], parameters,
				credentials: { [BRAND.credentialName]: { id: credId, name: 'smoke-113-1a' } },
				...(continueOnFail ? { onError: 'continueRegularOutput' } : {}),
			},
		],
		connections: { Hook: { main: [[{ node: 'Items', type: 'main', index: 0 }]] }, Items: { main: [[{ node: 'Planner', type: 'main', index: 0 }]] } },
		settings: {},
	});
	if (wf.status !== 200) return { status: wf.status, data: wf.data };
	try {
		const act = await n8n('POST', `/workflows/${wf.data.id}/activate`);
		if (act.status !== 200) return { status: act.status, data: act.data };
		return await http(n8nUrl, {}, 'POST', '/webhook/' + hook, { items });
	} finally {
		await n8n('POST', `/workflows/${wf.data.id}/deactivate`);
		await n8n('DELETE', `/workflows/${wf.data.id}`);
	}
}
const ok = async (name, parameters, opts) => {
	const r = await node(parameters, opts);
	check(name, r.status === 200 && Array.isArray(r.data), r.data);
	return Array.isArray(r.data) ? r.data : [];
};
const refused = async (name, parameters, reason, opts = {}) => {
	const r = await node(parameters, { continueOnFail: true, ...opts });
	const j = Array.isArray(r.data) ? r.data[0] : null;
	check(name + ' → ' + reason, !!j && j.ok === false && (Array.isArray(reason) ? reason.includes(j.reason) : j.reason === reason), r.data);
	return j;
};
const P = (resource, operation, extra = {}) => ({ resource, operation, project: PR, ...extra });

try {
	// 2. Reads
	const [ov] = await ok('Project → Overview', P('project', 'getOverview'));
	check('overview: planner ≥ 3.49.1, configured', ov?.contractOk === true && ov?.configured === true, ov);
	const [sp] = await ok('Sprint → Get', P('sprint', 'get'));
	await ok('History → List', P('history', 'getMany', { limit: 3 }));
	await ok('Capacity → Get', P('capacity', 'get'));
	await ok('Calendar → Get', P('calendar', 'get'));
	await ok('Reminder → List', P('reminder', 'getMany', { options: { includeJournal: true } }));
	const [roles] = await ok('Access → My Roles', P('access', 'getMyRoles'));
	check('my roles: 9 keys', roles && Object.keys(roles.roles || {}).length >= 9, roles);
	const projects = await ok('Project → List', { resource: 'project', operation: 'getMany', search: projectKey, returnAll: true });
	check('project list: the project with the planner', projects.some((p) => p.key === projectKey && p.planner === true), projects);
	const [st] = await ok('Project → Planner Status', P('project', 'getPlannerStatus'));
	check('status: attached, version', st?.attached === true && typeof st?.version === 'string', st);
	const found = await ok('YouTrack Issue → Search', { resource: 'issue', operation: 'search', query: 'sort by: created', limit: 3, options: { project: projectKey } });
	check('search: project issues with fields', found.length > 0 && found.every((x) => x.project === projectKey && x.fields), found);

	// 3. Refusals
	const badCred = await n8n('POST', '/credentials', { name: 'smoke-113-1a-bad', type: BRAND.credentialName, data: { url: ytUrl, token: 'perm-bad.token', appId: BRAND.appId } });
	try {
		await refused('Project → Overview (bad token)', P('project', 'getOverview'), 'http_401', { credId: badCred.data?.id });
	} finally {
		if (badCred.data?.id) await n8n('DELETE', '/credentials/' + badCred.data.id);
	}
	await refused('Sprint → Get (unknown project)', { resource: 'sprint', operation: 'get', project: { __rl: true, mode: 'key', value: 'NoSuchProject113' } }, 'project_unavailable');
	if (sp?.sprint && sp.sprint.status !== 'FINISHED') {
		await refused('Sprint → Upload draft into an occupied slot', P('sprint', 'uploadDraft', { sprintId: 'smoke-113-never', name: 'smoke', dateStart: '2031-01-01T00:00:00.000Z', dateEnd: '2031-01-14T00:00:00.000Z', items: '{"analysis":[]}' }), 'slot_occupied');
	} else console.log('SKIP  slot_occupied — the slot is empty or the sprint is finished');

	// 4. Sprint item round: the revision grows on every write; two items per run — the revision carries over
	const SMOKE = projectKey + '-999113';
	if (sp?.sprint?.sprintId) {
		const rev = sp.sprint.rev;
		const [a] = await ok('Sprint Item → Add', P('sprintItem', 'createOrUpdate', { roleKey: 'analysis', issueId: SMOKE, additionalFields: { title: 'n8n-smoke', inclusionStatus: 'INC_PLANNED', estimate: 60 } }));
		check('add: rev +1', a?.rev === rev + 1, a);
		const pair = await ok('two items: change the estimate and remove', P('sprintItem', 'createOrUpdate', { roleKey: 'analysis', issueId: SMOKE, additionalFields: { estimate: '={{ $json.estimate }}' } }), { items: [{ estimate: 120 }, { estimate: 180 }] });
		check('revision carry-over: rev +1, +1 without retry', pair.length === 2 && pair[0].rev === rev + 2 && pair[1].rev === rev + 3 && !pair[0].retried && !pair[1].retried, pair);
		const split = await ok('Sprint → Get (items)', P('sprint', 'get', { options: { splitIntoItems: true, roleKey: 'analysis' } }));
		check('estimate 180 in place', split.some((x) => x.issueId === SMOKE && x.estimate === 180), split.filter((x) => x.issueId === SMOKE));
		await refused('Sprint Item → stale revision', P('sprintItem', 'createOrUpdate', { roleKey: 'analysis', issueId: SMOKE, options: { revision: rev } }), 'rev_conflict');
		const [rm] = await ok('Sprint Item → Remove', P('sprintItem', 'remove', { roleKey: 'analysis', issueId: SMOKE }));
		check('remove: rev +1', rm?.rev === rev + 4, rm);
		const [hd] = await ok('Sprint → Update header (same name)', P('sprint', 'update', { updateFields: { name: sp.sprint.name } }));
		check('header: rev +1', hd?.rev === rev + 5, hd);
	} else console.log('SKIP  sprint operations — the slot is empty');

	// 5. Absence round-trip (calendar dates)
	const [ua] = await ok('Absence → Add', P('absence', 'createOrUpdate', { login: 'n8n-smoke', from: '2031-01-13T00:00:00.000+03:00', to: '2031-01-14T00:00:00.000+03:00', type: 'vacation' }));
	const mine = await ok('Absence → List (login)', P('absence', 'getMany', { options: { login: 'n8n-smoke' } }));
	check('absence written with dates Jan 13–14', mine.length === 1 && mine[0].from === '2031-01-13' && mine[0].to === '2031-01-14', mine);
	const [da] = await ok('Absence → Delete', P('absence', 'delete', { login: 'n8n-smoke', from: '2031-01-13', to: '2031-01-14' }));
	check('absence deleted: rev +1', da?.deleted === true && da.rev === ua?.rev + 1, da);

	// 6. Release: create → issues → status → delete
	const RID = 'n8n-smoke-113';
	const RL = { __rl: true, mode: 'id', value: RID };
	const [cr] = await ok('Release → Create', P('release', 'createOrUpdate', { releaseId: RID, additionalFields: { name: 'n8n-smoke', kind: 'release', source: 'internal', status: 'planned', plannedDate: '2031-01-01T00:00:00.000Z' } }));
	const [ui] = await ok('Release → Add and remove issues', P('release', 'updateIssues', { release: RL, additionalFields: { issuesToAdd: `${projectKey}-1, ${projectKey}-2`, issuesToRemove: `${projectKey}-1` } }));
	check('issues: +2 −1, rev +2', ui?.added?.length === 2 && ui?.removed?.length === 1 && ui.rev === cr?.rev + 2, ui);
	await ok('Release → Set status prep', P('release', 'setStatus', { release: RL, status: 'prep' }));
	const rels = await ok('Release → List', P('release', 'getMany', { returnAll: true, options: { status: 'prep' } }));
	const r = rels.find((x) => x.id === RID);
	check('release: prep, issues [-2]', !!r && JSON.stringify(r.issues) === JSON.stringify([projectKey + '-2']), r);
	const [dr] = await ok('Release → Delete', P('release', 'delete', { release: RL }));
	check('release deleted', dr?.deleted === true && dr.id === RID, dr);
	await refused('Release → Delete again', P('release', 'delete', { release: RL }), 'release_not_found');

	// 7. Set field (stock) — one per field type, write → check → restore (spec §6)
	await fieldRound();
	await refused('Set field through the planner (field not in settings)', P('issue', 'setFieldViaPlanner', { issueId, fieldName: 'NoSuchField113', fieldType: 'enum', value: 'x' }), ['field_not_whitelisted', 'field_not_found', 'plugin_not_configured', 'assigner_rights_required']);
} finally {
	await n8n('DELETE', '/credentials/' + cred.data.id);
	const left = (await n8n('GET', '/workflows?limit=250')).data?.data?.filter((w) => w.name.startsWith('smoke-113-1a')) ?? [];
	check('n8n stand clean: smoke workflows deleted', left.length === 0, left.map((w) => w.id));
}

async function fieldRound() {
	const pf = (await yt('GET', `/api/admin/projects/${issueId.replace(/-\d+$/, '')}/customFields?fields=id,canBeEmpty,field(name,fieldType(id)),bundle(id,values(name),aggregatedUsers(login))&$top=200`)).data;
	const pick = (type, pred = () => true) => pf.find((f) => f.field.fieldType.id === type && pred(f));
	const current = async (id) => (await yt('GET', `/api/issues/${issueId}?fields=customFields(id,value(name,login,minutes,text))`)).data.customFields.find((f) => f.id === id)?.value ?? null;
	const setViaNode = (f, value) => node(P('issue', 'setField', { issueId, field: `${f.id}|${f.field.fieldType.id}`, ...(value === null ? { clearField: true } : { value }) }));
	const plain = (v) => (v && typeof v === 'object' ? v.login ?? v.name ?? v.minutes ?? v.text ?? null : v);

	/** Write a value and restore the original; exp — the expected value after the write (defaults to the same). */
	async function round(label, f, value, exp = value) {
		if (!f) return console.log('SKIP  field of type ' + label + ' — none in the project');
		const before = plain(await current(f.id));
		const w = await setViaNode(f, value);
		check(`Set field: ${label} "${f.field.name}"`, w.status === 200 && Array.isArray(w.data), w.data);
		check(`  value written (${label})`, plain(await current(f.id)) === exp, await current(f.id));
		const back = await setViaNode(f, before === null ? null : String(before));
		check(`  restored (${label})`, back.status === 200 && plain(await current(f.id)) === before, await current(f.id));
	}

	const enumF = pick('enum[1]', (f) => (f.bundle?.values?.length ?? 0) >= 2 && !f.canBeEmpty);
	const cur = enumF ? plain(await current(enumF.id)) : null;
	await round('enum', enumF, enumF?.bundle.values.map((v) => v.name).find((n) => n !== cur));
	const stateF = pick('state[1]');
	if (stateF) {
		const s = plain(await current(stateF.id));
		const w = await setViaNode(stateF, s);
		check(`Set field: state "${stateF.field.name}" with the same value`, w.status === 200 && plain(await current(stateF.id)) === s, w.data);
	}
	await round('version[1]', pick('version[1]', (f) => f.bundle?.values?.length), pick('version[1]', (f) => f.bundle?.values?.length)?.bundle.values[0].name);
	const userF = pick('user[1]', (f) => f.canBeEmpty && (f.bundle?.aggregatedUsers?.length ?? 0) >= 2);
	const curUser = userF ? plain(await current(userF.id)) : null;
	await round('user', userF, userF?.bundle.aggregatedUsers.map((u) => u.login).find((l) => l !== curUser));
	await round('period', pick('period'), '180', 180);
	await round('text', pick('text'), 'n8n-smoke');
	await round('string', pick('string'), 'n8n-smoke');
	await round('integer', pick('integer'), '42', 42);
	await round('date', pick('date'), '2031-01-13T00:00:00.000+03:00', Date.UTC(2031, 0, 13, 12));
	const multi = pick('version[*]');
	if (multi) await refused(`Set field: multi-value "${multi.field.name}"`, P('issue', 'setField', { issueId, field: `${multi.id}|version[*]`, value: 'x' }), 'multi_value_field');

	// build and owned: to a temporary bundle value and back (the stand bundle may be empty)
	for (const [type, kind] of [['build[1]', 'build'], ['ownedField[1]', 'ownedField']]) {
		const f = pick(type);
		if (!f) { console.log('SKIP  field of type ' + type + ' — none in the project'); continue; }
		const name = 'n8n-smoke-113';
		const added = await yt('POST', `/api/admin/customFieldSettings/bundles/${kind}/${f.bundle.id}/values?fields=id,name`, { name });
		if (!check(`bundle ${type}: temporary value added`, added.status === 200 && added.data?.id, added.data)) continue;
		try {
			await round(type, f, name);
		} finally {
			const del = await yt('DELETE', `/api/admin/customFieldSettings/bundles/${kind}/${f.bundle.id}/values/${added.data.id}`);
			check(`bundle ${type}: temporary value removed`, del.status === 200, del.data);
		}
	}
}

console.log('\nRESULT: ' + (failed.length ? 'FAIL (' + failed.length + '): ' + failed.join('; ') : 'PASS'));
process.exit(failed.length ? 1 : 0);
