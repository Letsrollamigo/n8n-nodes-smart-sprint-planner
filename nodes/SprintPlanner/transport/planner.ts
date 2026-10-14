import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
} from 'n8n-workflow';
import { CONTRACT_PATHS } from '../shared/constants.js';
import { NetworkError, PlannerRefusal, PlatformError } from '../shared/errors.js';
import { BRAND } from '../branding';

export type Ctx = IExecuteFunctions | ILoadOptionsFunctions;
export type CallOpts = { projectKey?: string; query?: Record<string, unknown>; body?: unknown };
export type Call = (method: 'GET' | 'POST', path: string, opts?: CallOpts) => Promise<Record<string, unknown>>;

/** Paths the node calls: the shared-layer contract plus issue field write through the planner (node-only). */
const PATHS: readonly string[] = [...CONTRACT_PATHS, 'update-issue-field'];
export const TIMEOUT_MS = 30000;

/** YouTrack URL and application id from the credentials. */
export async function credentialsOf(ctx: Ctx): Promise<{ url: string; appId: string }> {
	const c = await ctx.getCredentials(BRAND.credentialName);
	return { url: String(c.url ?? '').replace(/\/+$/, ''), appId: String(c.appId || BRAND.appId) };
}

/** Request failure (network, DNS, axios timeout) → shared-layer NetworkError with the timeout flag. */
export function networkError(cause: unknown, baseUrl: string): NetworkError {
	const ne = new NetworkError(cause, baseUrl);
	const c = cause as { code?: unknown; cause?: { code?: unknown }; message?: unknown } | null;
	const text = [c?.code, c?.cause?.code, c?.message].map((v) => String(v ?? '')).join(' ');
	if (/ECONNABORTED|ETIMEDOUT|timeout/i.test(text)) ne.timeout = true;
	return ne;
}

/** Response body text for diagnostics (at most 300 characters). */
export function bodyText(body: unknown): string {
	return (typeof body === 'string' ? body : JSON.stringify(body ?? '')).slice(0, 300);
}

/** Request with the node credentials; network failure → NetworkError, HTTP status is not thrown. */
export async function send(ctx: Ctx, baseUrl: string, options: IHttpRequestOptions): Promise<IN8nHttpFullResponse> {
	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, BRAND.credentialName, {
			...options,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: TIMEOUT_MS,
		})) as IN8nHttpFullResponse;
	} catch (e) {
		throw networkError(e, baseUrl);
	}
}

/** `call()` of the planner contract (shared-layer Client interface): envelope → PlatformError / PlannerRefusal. */
export function makePlannerCall(ctx: Ctx): Call {
	let creds: Promise<{ url: string; appId: string }> | undefined;
	return async (method, path, opts = {}) => {
		if (!PATHS.includes(path)) throw new Error('path outside contract: ' + path);
		creds ??= credentialsOf(ctx);
		const { url, appId } = await creds;
		const qs: IDataObject = {};
		if (opts.projectKey) qs.projectKey = opts.projectKey;
		for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') qs[k] = String(v);
		const res = await send(ctx, url, {
			method,
			url: `${url}/api/extensionEndpoints/${appId}/backend-global/${path}`,
			qs,
			body: opts.body as IDataObject | undefined,
		});
		if (res.statusCode !== 200) throw new PlatformError(res.statusCode, bodyText(res.body));
		const body = res.body;
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PlatformError(200, 'unexpected body: ' + bodyText(body));
		const obj = body as Record<string, unknown>;
		if (obj.success === false) throw new PlannerRefusal(obj);
		return obj;
	};
}
