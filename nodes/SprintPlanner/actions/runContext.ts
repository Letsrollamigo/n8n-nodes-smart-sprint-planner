import type { IExecuteFunctions } from 'n8n-workflow';
import { bodyRev, makeOps, slotRev, withRev } from '../shared/ops.js';
import { PlannerRefusal } from '../shared/errors.js';
import { makePlannerCall, type Call } from '../transport/planner';

export type Ops = ReturnType<typeof makeOps>;
export type RevKind = 'slot' | 'abs' | 'rel';
export type Obj = Record<string, unknown>;
export type Written = { result: Obj; retried: boolean };

/** Context of one node run: contract operations and the “project × registry” revision memory across items. */
export class RunContext {
	readonly call: Call;

	readonly ops: Ops;

	private readonly revs = new Map<string, number>();

	constructor(readonly fn: IExecuteFunctions) {
		this.call = makePlannerCall(fn);
		this.ops = makeOps({ call: this.call });
	}

	/** Registry revision: from the run memory, otherwise (or when `fresh`) by reading the contract. */
	async readRev(kind: RevKind, key: string, fresh = false): Promise<number> {
		const k = key + ':' + kind;
		const known = this.revs.get(k);
		if (known !== undefined && !fresh) return known;
		const rev =
			kind === 'slot'
				? slotRev(await this.ops.sprintData(key))
				: bodyRev(await (kind === 'abs' ? this.ops.absences(key) : this.ops.releases(key)));
		this.revs.set(k, rev);
		return rev;
	}

	/** Revision after a write (or from a rev_conflict refusal); when unknown, forget it and the next item re-reads. */
	remember(kind: RevKind, key: string, rev: unknown): void {
		const k = key + ':' + kind;
		if (typeof rev === 'number') this.revs.set(k, rev);
		else this.revs.delete(k);
	}

	/**
	 * Point write with a revision: `baseRev` from Options — one call, no retry; otherwise the revision comes from memory
	 * or from a read, with exactly one retry on rev_conflict (the re-read bypasses memory).
	 */
	write(kind: RevKind, key: string, baseRev: number | undefined, run: (rev: number) => Promise<Obj>, retry = true): Promise<Written> {
		let reads = 0;
		const readRev = () => this.readRev(kind, key, reads++ > 0);
		return withRev({ baseRev, readRev, run, retry }).then(
			(r) => {
				this.remember(kind, key, r.result.rev);
				return r;
			},
			(e: unknown) => {
				this.remember(kind, key, e instanceof PlannerRefusal && e.reason === 'rev_conflict' ? e.rev : undefined);
				throw e;
			},
		);
	}
}

/** Output of a point write: revision, what was applied, whether it retried (and the history revision for assignment). */
export function written(r: Written): Obj {
	const out: Obj = { rev: r.result.rev ?? null, applied: r.result.applied ?? null, retried: r.retried };
	if (r.result.historyRev !== undefined) out.historyRev = r.result.historyRev;
	return out;
}
