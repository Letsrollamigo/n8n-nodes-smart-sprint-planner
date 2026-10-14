// Stock YouTrack REST: issue search, “Set field” by the issue field's actual $type (spec §6 probes),
// write through the planner, form list methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ctx, dist, project, run } from './_mock.mjs';

const { listSearch } = dist('methods/listSearch.js');
const { loadOptions } = dist('methods/loadOptions.js');
const { T } = dist('i18n.js');
const { fmt } = dist('transport/errors.js');

const P = (operation, extra = {}) => ({ resource: 'issue', operation, project: project(), ...extra });
const ISSUE = (fields) => ({ statusCode: 200, body: { idReadable: 'DEMO-5', customFields: fields } });

test('search — project key at the start of the query, paged to the limit, Simplified field values', async () => {
	const issue = (n) => ({
		id: '2-' + n,
		idReadable: 'DEMO-' + n,
		summary: 'S' + n,
		project: { shortName: 'DEMO', name: 'Demo' },
		customFields: [
			{ name: 'State', value: { name: 'Open' } },
			{ name: 'Assignee', value: { login: 'ivanov', name: 'Ivan', fullName: 'Ivan' } },
			{ name: 'Estimation', value: { minutes: 480, presentation: '1d' } },
			{ name: 'Fix versions', value: [{ name: '1.0' }, { name: '1.1' }] },
			{ name: 'Due', value: 1790000000000 },
			{ name: 'Empty', value: null },
		],
	});
	const routes = { 'GET /api/issues': (o) => ({ statusCode: 200, body: Array.from({ length: o.qs.$top }, (_, k) => issue(o.qs.$skip + k)) }) };
	const { json, calls } = await run(P('search', { query: '#Unresolved', limit: 150, options: { project: 'DEMO' } }), routes);
	assert.equal(json.length, 150);
	assert.deepEqual(calls.map((c) => [c.qs.$skip, c.qs.$top]), [[0, 100], [100, 50]]);
	assert.equal(calls[0].qs.query, 'project: DEMO #Unresolved');
	assert.deepEqual(json[0].fields, { State: 'Open', Assignee: 'ivanov', Estimation: 480, 'Fix versions': ['1.0', '1.1'], Due: 1790000000000, Empty: null });
	assert.equal(json[0].project, 'DEMO');
});

test('set field — $type comes from the issue (StateMachine), value shape by $type', async () => {
	const { json, calls } = await run(P('setField', { issueId: 'DEMO-5', field: '84-1|state[1]', value: 'In progress' }), {
		'GET /api/issues/DEMO-5': ISSUE([{ id: '84-1', name: 'State', $type: 'StateMachineIssueCustomField' }]),
		'POST /api/issues/DEMO-5': ISSUE([{ id: '84-1', name: 'State', $type: 'StateMachineIssueCustomField', value: { name: 'In progress' } }]),
	});
	assert.deepEqual(calls[1].body, { customFields: [{ id: '84-1', $type: 'StateMachineIssueCustomField', value: { name: 'In progress' } }] });
	assert.deepEqual(json[0], { idReadable: 'DEMO-5', field: { id: '84-1', name: 'State', value: 'In progress' } });
});

test('set field — user, period, text, simple, date (noon UTC of the calendar date), clear', async () => {
	const { valueFor } = dist('actions/issue/setField.operation.js');
	assert.deepEqual(valueFor('SingleUserIssueCustomField', 'user[1]', 'ivanov'), { login: 'ivanov' });
	assert.deepEqual(valueFor('PeriodIssueCustomField', 'period', '480'), { minutes: 480 });
	assert.deepEqual(valueFor('TextIssueCustomField', 'text', 'abc'), { text: 'abc' });
	assert.equal(valueFor('SimpleIssueCustomField', 'integer', '42'), 42);
	assert.equal(valueFor('SimpleIssueCustomField', 'float', '4.5'), 4.5);
	assert.equal(valueFor('SimpleIssueCustomField', 'string', 'x'), 'x');
	assert.deepEqual(valueFor('SingleVersionIssueCustomField', 'version[1]', '1.0'), { name: '1.0' });
	assert.deepEqual(valueFor('SingleOwnedIssueCustomField', 'ownedField[1]', 'Core'), { name: 'Core' });
	assert.equal(valueFor('DateIssueCustomField', 'date', '2026-10-01T00:00:00.000+03:00'), Date.UTC(2026, 9, 1, 12));
	assert.equal(valueFor('DateIssueCustomField', 'date and time', '2026-10-01T09:00:00.000Z'), Date.parse('2026-10-01T09:00:00.000Z'));
	assert.throws(() => valueFor('SomethingNewIssueCustomField', 'x', 'v'), (e) => e.details.problem === fmt(T.problems.unsupportedType, { type: 'SomethingNewIssueCustomField' }));
	assert.throws(() => valueFor('PeriodIssueCustomField', 'period', 'abc'), (e) => e.details.problem.startsWith(T.problems.integer.split('{')[0]));
	const { calls } = await run(P('setField', { issueId: 'DEMO-5', field: '84-2|user[1]', clearField: true }), {
		'GET /api/issues/DEMO-5': ISSUE([{ id: '84-2', name: 'Assignee', $type: 'SingleUserIssueCustomField' }]),
		'POST /api/issues/DEMO-5': ISSUE([]),
	});
	assert.equal(calls[1].body.customFields[0].value, null);
});

test('set field — multi-value and a field outside the issue project — refusal before writing', async () => {
	const multi = await run(P('setField', { issueId: 'DEMO-5', field: '84-3|version[*]', value: '1.0' }), {}).catch((e) => e);
	assert.ok(multi.message.startsWith(T.guards.multi_value_field.message.split('{')[0]));
	const multiByType = await run(P('setField', { issueId: 'DEMO-5', field: '84-3|version[1]', value: '1.0' }), {
		'GET /api/issues/DEMO-5': ISSUE([{ id: '84-3', name: 'Fix versions', $type: 'MultiVersionIssueCustomField' }]),
	}).catch((e) => e);
	assert.ok(multiByType.message.startsWith(T.guards.multi_value_field.message.split('{')[0]));
	const missing = await run(P('setField', { issueId: 'DEMO-5', field: '99-9|enum[1]', value: 'x' }), { 'GET /api/issues/DEMO-5': ISSUE([]) }).catch((e) => e);
	assert.equal(missing.message, fmt(T.guards.field_not_in_issue.message, { issueId: 'DEMO-5' }));
	const badPick = await run(P('setField', { issueId: 'DEMO-5', field: 'State', value: 'x' }), {}).catch((e) => e);
	assert.ok(badPick.message.includes(T.problems.fieldValue));
});

test('YouTrack error — YouTrack text in message', async () => {
	const err = await run(P('setField', { issueId: 'DEMO-5', field: '84-1|enum[1]', value: 'Nope' }), {
		'GET /api/issues/DEMO-5': ISSUE([{ id: '84-1', name: 'Priority', $type: 'SingleEnumIssueCustomField' }]),
		'POST /api/issues/DEMO-5': { statusCode: 400, body: { error: 'bad_request', error_description: 'Value not found' } },
	}).catch((e) => e);
	assert.equal(err.message, 'Value not found');
});

test('through the planner — update-issue-field with projectKey; period — integer minutes; clear — null', async () => {
	const { json, calls } = await run(P('setFieldViaPlanner', { issueId: 'DEMO-5', fieldName: 'Estimate', fieldType: 'period', value: '480' }), {
		'POST update-issue-field': { issueId: 'DEMO-5', fieldName: 'Estimate' },
	});
	assert.equal(calls[0].qs.projectKey, 'DEMO');
	assert.deepEqual(calls[0].body, { issueId: 'DEMO-5', fieldName: 'Estimate', type: 'period', value: 480 });
	assert.deepEqual(json[0], { issueId: 'DEMO-5', fieldName: 'Estimate' });
	const clr = await run(P('setFieldViaPlanner', { issueId: 'DEMO-5', fieldName: 'Analyst', fieldType: 'user', clearField: true }), { 'POST update-issue-field': {} });
	assert.equal(clr.calls[0].body.value, null);
});

test('searchProjects method — only projects with the planner, no archived ones, paged', async () => {
	const page = Array.from({ length: 50 }, (_, n) => ({ shortName: 'P' + n, name: 'Project ' + n, archived: n === 2 }));
	const c = ctx({
		routes: {
			'GET /api/admin/projects': { statusCode: 200, body: page },
			'POST filter-planner-projects': (o) => ({ statusCode: 200, body: { success: true, projects: o.body.keys.filter((k) => ['P1', 'P2', 'P3'].includes(k)).map((key) => ({ key })) } }),
		},
	});
	const r = await listSearch.searchProjects.call(c.fn, 'Pro', '50');
	assert.deepEqual(r.results, [
		{ name: 'Project 1 (P1)', value: 'P1' },
		{ name: 'Project 3 (P3)', value: 'P3' },
	]);
	assert.equal(r.paginationToken, '100');
	assert.equal(c.calls[0].qs.$skip, 50);
	assert.equal(c.calls[0].qs.query, 'Pro');
});

test('searchReleases method — project releases with a filter; expression project — a hint', async () => {
	const c = ctx({ params: [{ project: project('DEMO') }], routes: { 'GET releases': { releases: [{ id: 'R1', name: 'Autumn' }, { id: 'R2', name: 'Winter' }] } } });
	assert.deepEqual((await listSearch.searchReleases.call(c.fn, 'wint')).results, [{ name: 'Winter (R2)', value: 'R2' }]);
	const e = ctx({ params: [{ project: { __rl: true, mode: 'key', value: '={{ $json.key }}' } }] });
	assert.deepEqual((await listSearch.searchReleases.call(e.fn)).results, [{ name: T.lists.selectProject, value: '' }]);
	assert.equal(e.calls.length, 0);
});

test('getProjectFields method — value <id>|<type>, multi-value marked, sorted by name', async () => {
	const c = ctx({
		params: [{ project: project('DEMO') }],
		routes: {
			'GET /api/admin/projects/DEMO/customFields': {
				statusCode: 200,
				body: [
					{ id: '84-2', field: { name: 'State', fieldType: { id: 'state[1]' } } },
					{ id: '84-3', field: { name: 'Fix versions', fieldType: { id: 'version[*]' } } },
				],
			},
		},
	});
	const opts = await loadOptions.getProjectFields.call(c.fn);
	assert.deepEqual(opts, [
		{ name: 'Fix versions ' + T.lists.multiValue, value: '84-3|version[*]', description: 'version[*]' },
		{ name: 'State', value: '84-2|state[1]', description: 'state[1]' },
	]);
});
