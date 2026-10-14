import type { IDataObject, INodeProperties } from 'n8n-workflow';
import { fld, epochOf, minutesField, minutesOf, roleMapField, roleMapOf, text, type Obj } from '../fields';

/** Optional sprint header fields (shared by draft upload and header update). */
export const optionalHeaderFields = (): INodeProperties[] => [
	fld('sprintGoal', { type: 'string', default: '' }),
	fld('sprintFieldVal', { type: 'string', default: '' }),
	fld('versionFieldVal', { type: 'string', default: '' }),
	roleMapField('resources', minutesField('minutes', 'resourceMinutes')),
];

/** Sprint header from parameters: only filled fields, with length, date and minutes checks. */
export function readHeader(o: IDataObject): Obj {
	const out: Obj = {};
	const put = (k: string, v: unknown) => {
		if (v !== undefined) out[k] = v;
	};
	put('name', text(o.name, 'name', 500));
	put('dateStart', epochOf(o.dateStart, 'dateStart'));
	put('dateEnd', epochOf(o.dateEnd, 'dateEnd'));
	put('sprintGoal', text(o.sprintGoal, 'sprintGoal', 500));
	put('sprintFieldVal', text(o.sprintFieldVal, 'sprintFieldVal', 500));
	put('versionFieldVal', text(o.versionFieldVal, 'versionFieldVal', 500));
	const res = roleMapOf(o.resources, 'minutes');
	if (Object.keys(res).length) {
		const m: Obj = {};
		for (const [r, v] of Object.entries(res)) m[r] = minutesOf(v, 'resourceMinutes');
		out.resources = m;
	}
	return out;
}
