import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ThreadsError } from './types.js';

const id = z.string().regex(/^\d{1,40}$/, 'Expected a numeric Threads API ID');
const username = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
const replyControl = z.enum(['everyone', 'accounts_you_follow', 'mentioned_only', 'parent_post_author_only', 'followers_only']);
const publicUrl = z.string().url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password;
}, 'Use an HTTPS URL without embedded credentials');
export const officialContainerSchema = z.object({
  media_type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL']),
  text: z.string().refine(value => Array.from(value).length <= 500, 'Text exceeds 500 Unicode code points').optional(), image_url: publicUrl.optional(), video_url: publicUrl.optional(),
  children: z.array(id).min(2).max(20).optional(), is_carousel_item: z.boolean().optional(),
  reply_to_id: id.optional(), quote_post_id: id.optional(), reply_control: replyControl.optional(),
  enable_reply_approvals: z.boolean().optional(), alt_text: z.string().max(1000).optional(),
  link_attachment: publicUrl.optional(), topic_tag: z.string().min(1).max(50).regex(/^[^.&]+$/).optional(),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.media_type === 'TEXT' && !v.text?.trim()) issue('TEXT requires nonempty text');
  if ((v.media_type === 'IMAGE') !== !!v.image_url) issue('IMAGE requires image_url, exclusive to IMAGE');
  if ((v.media_type === 'VIDEO') !== !!v.video_url) issue('VIDEO requires video_url, exclusive to VIDEO');
  if ((v.media_type === 'CAROUSEL') !== !!v.children) issue('CAROUSEL requires children, exclusive to CAROUSEL');
  if (v.children && new Set(v.children).size !== v.children.length) issue('Carousel children must be unique');
  if (v.reply_to_id && v.quote_post_id) issue('Choose reply_to_id or quote_post_id');
  if (v.link_attachment && v.media_type !== 'TEXT') issue('Link attachments require TEXT');
  if (v.is_carousel_item && (!['IMAGE', 'VIDEO'].includes(v.media_type) || v.reply_to_id || v.quote_post_id || v.reply_control || v.enable_reply_approvals)) issue('Carousel children must be standalone IMAGE or VIDEO containers');
});
export type OfficialContainerInput = z.infer<typeof officialContainerSchema>;
export const officialActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create_container'), container: officialContainerSchema }).strict(),
  z.object({ kind: z.literal('publish_container'), creation_id: id }).strict(),
  z.object({ kind: z.literal('delete_post'), post_id: id }).strict(),
  z.object({ kind: z.literal('hide_reply'), reply_id: id, hide: z.boolean() }).strict(),
  z.object({ kind: z.literal('manage_pending_reply'), reply_id: id, approve: z.boolean() }).strict(),
]);
export type OfficialAction = z.infer<typeof officialActionSchema>;
export const officialReadOperationSchema = z.enum([
  'own_profile', 'profile_lookup', 'own_posts', 'profile_posts', 'post', 'search', 'mentions',
  'replies', 'conversation', 'pending_replies', 'post_insights', 'user_insights', 'container_status', 'publishing_limit',
]);
export type OfficialReadOperation = z.infer<typeof officialReadOperationSchema>;
export const officialReadInputSchema = z.object({
  id: id.optional(), username: username.optional(), q: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(), after: z.string().min(1).max(4096).optional(),
  before: z.string().min(1).max(4096).optional(), since: z.string().max(64).optional(), until: z.string().max(64).optional(),
  reverse: z.boolean().optional(), approval_status: z.enum(['pending', 'ignored']).optional(),
  search_type: z.enum(['TOP', 'RECENT']).optional(), search_mode: z.enum(['KEYWORD', 'TAG']).optional(),
  media_type: z.enum(['TEXT', 'IMAGE', 'VIDEO']).optional(), author_username: username.optional(),
  metric: z.string().regex(/^[a-z_]+(?:,[a-z_]+)*$/).max(300).optional(),
  breakdown: z.enum(['country', 'city', 'age', 'gender']).optional(),
}).strict();
export type OfficialReadInput = z.infer<typeof officialReadInputSchema>;
export interface OfficialApiOptions {
  accessToken?: string; userId?: string; writesEnabled?: boolean; timeoutMs?: number;
  preparedTtlMs?: number; fetch?: typeof fetch; now?: () => number;
}
export interface OfficialPreparedAction {
  preparedId: string; expiresAt: string; account: { id: string; username: string }; action: OfficialAction;
}
export interface OfficialApiResult {
  source: 'official_threads_api'; observedAt: string; operation: string; data: Record<string, unknown>;
  completeness: 'api_page'; warnings: string[];
}
export interface OfficialMutationResult extends OfficialApiResult {
  outcome: 'api_confirmed'; preparedId: string; accountId: string; action: OfficialAction;
}
export class OfficialApiError extends ThreadsError {
  constructor(code: string, message: string, public outcome: 'not_sent' | 'rejected' | 'unknown', public httpStatus?: number) {
    super(code, message, false);
  }
}
export function officialApiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OfficialApiOptions {
  return { accessToken: env.THREADS_API_ACCESS_TOKEN, userId: env.THREADS_API_USER_ID,
    writesEnabled: env.THREADS_ALLOW_WRITES === 'true' };
}
const postFields = 'id,text,username,permalink,timestamp,media_type,media_url,shortcode,has_replies,is_reply,is_quote_post';
const replyFields = `${postFields},root_post,replied_to,hide_status`;
type Params = Record<string, string | number | boolean | undefined>;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Optional authenticated official API transport. No browser cookies, token logging, redirects or automatic mutation retries. */
export class OfficialThreadsApi {
  #token: string; #userId: string; #writesEnabled: boolean; #fetch: typeof fetch;
  #timeoutMs: number; #ttl: number; #now: () => number;
  #prepared = new Map<string, { value: OfficialPreparedAction; expires: number }>();
  constructor(options: OfficialApiOptions = officialApiOptionsFromEnv()) {
    this.#token = options.accessToken?.trim() ?? '';
    this.#userId = options.userId?.trim() || 'me';
    if (this.#userId !== 'me' && !id.safeParse(this.#userId).success) throw new ThreadsError('INVALID_INPUT', 'THREADS_API_USER_ID must be a numeric API user ID');
    this.#writesEnabled = options.writesEnabled === true;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = Math.min(60_000, Math.max(100, options.timeoutMs ?? 20_000));
    this.#ttl = Math.min(300_000, Math.max(1000, options.preparedTtlMs ?? 120_000));
    this.#now = options.now ?? Date.now;
  }
  status() {
    return { source: 'official_threads_api', configured: !!this.#token, userId: this.#userId,
      writesEnabled: this.#writesEnabled, writeIdentityConfigured: this.#userId !== 'me',
      authentication: 'not_checked', scopes: 'not_checked', liveWriteVerified: false };
  }
  #parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ThreadsError('INVALID_INPUT', this.#sanitize(result.error.issues.map(x => x.message).join('; ')) as string);
    if (this.#token && JSON.stringify(result.data).includes(this.#token)) throw new ThreadsError('INVALID_INPUT', 'Input must not include the configured credential');
    return result.data;
  }
  #sanitize(value: unknown): unknown {
    if (typeof value === 'string') {
      let clean = value;
      if (this.#token) for (const token of [this.#token, encodeURIComponent(this.#token)]) clean = clean.split(token).join('[REDACTED]');
      return clean.replace(/([?&](?:access_token|appsecret_proof)=)[^&\s"<>]*/gi, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map(v => this.#sanitize(v));
    if (object(value)) return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['access_token', 'refresh_token', 'appsecret_proof', 'authorization', 'next', 'previous'].includes(key.toLowerCase()))
      .map(([key, v]) => [this.#sanitize(key) as string, this.#sanitize(v)]));
    return value;
  }
  async #request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<Record<string, unknown>> {
    if (!this.#token) throw new OfficialApiError('API_NOT_CONFIGURED', 'Set THREADS_API_ACCESS_TOKEN in the server environment', 'not_sent');
    const url = new URL(`https://graph.threads.com/v1.0/${path}`);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, String(value));
    if (method === 'GET') url.search = body.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.#token}`, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(method !== 'GET' ? { body } : {}) });
      let parsed: unknown;
      try { parsed = await response.json(); } catch {
        throw new OfficialApiError('API_INVALID_RESPONSE', 'Official API returned an unreadable response; no retry was performed', method === 'GET' ? 'rejected' : 'unknown', response.status);
      }
      if (!response.ok || (object(parsed) && parsed.error)) {
        const apiError = object(parsed) && object(parsed.error) ? parsed.error : {};
        const auth = response.status === 401 || apiError.code === 190;
        const permission = response.status === 403 || apiError.code === 10 || apiError.code === 200;
        const limited = response.status === 429 || [4, 17, 32, 613].includes(Number(apiError.code));
        const unknown = method !== 'GET' && (response.status >= 500 || response.status === 408);
        throw new OfficialApiError(auth ? 'API_AUTH_REQUIRED' : permission ? 'API_PERMISSION_REQUIRED' : limited ? 'API_RATE_LIMITED' : 'API_REQUEST_FAILED',
          `Official API rejected the request (HTTP ${response.status}${typeof apiError.code === 'number' ? `, code ${apiError.code}` : ''}); no retry was performed`, unknown ? 'unknown' : 'rejected', response.status);
      }
      if (!object(parsed)) throw new OfficialApiError('API_INVALID_RESPONSE', 'Expected an API response object; no retry was performed', method === 'GET' ? 'rejected' : 'unknown');
      return this.#sanitize(parsed) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof OfficialApiError) throw error;
      throw new OfficialApiError('API_TRANSPORT_FAILED', 'Official API transport failed or timed out; no retry was performed', method === 'GET' ? 'not_sent' : 'unknown');
    } finally { clearTimeout(timer); }
  }
  #result(operation: string, data: Record<string, unknown>): OfficialApiResult {
    return { source: 'official_threads_api', observedAt: new Date(this.#now()).toISOString(), operation, data,
      completeness: 'api_page', warnings: ['One API response only; permissions, visibility and API limits apply. Missing values are not zero. Pagination URLs are omitted; use returned cursors.'] };
  }
  async read(operation: OfficialReadOperation, raw: OfficialReadInput = {}): Promise<OfficialApiResult> {
    operation = this.#parse(officialReadOperationSchema, operation);
    const input = this.#parse(officialReadInputSchema, raw);
    const required = (key: 'id' | 'username' | 'q') => {
      const value = input[key]; if (!value) throw new ThreadsError('INVALID_INPUT', `${operation} requires ${key}`); return value;
    };
    const page: Params = { limit: input.limit, after: input.after, before: input.before, since: input.since, until: input.until };
    let path: string; let params: Params;
    switch (operation) {
      case 'own_profile': path = 'me'; params = { fields: 'id,username,name,threads_profile_picture_url,threads_biography,is_verified' }; break;
      case 'profile_lookup': path = 'profile_lookup'; params = { username: required('username') }; break;
      case 'own_posts': path = `${this.#userId}/threads`; params = { ...page, fields: postFields }; break;
      case 'profile_posts': path = 'profile_posts'; params = { ...page, username: required('username'), fields: postFields }; break;
      case 'post': path = required('id'); params = { fields: `${postFields},owner,children,root_post,replied_to,quoted_post` }; break;
      case 'search': path = 'keyword_search'; params = { ...page, q: required('q'), fields: postFields, search_type: input.search_type ?? 'TOP', search_mode: input.search_mode ?? 'KEYWORD', media_type: input.media_type, author_username: input.author_username }; break;
      case 'mentions': path = `${this.#userId}/mentions`; params = { ...page, fields: postFields }; break;
      case 'replies': case 'conversation': case 'pending_replies':
        path = `${required('id')}/${operation}`; params = { ...page, fields: replyFields + (operation === 'pending_replies' ? ',reply_approval_status' : ''), reverse: input.reverse,
          ...(operation === 'pending_replies' ? { approval_status: input.approval_status } : {}) }; break;
      case 'post_insights': path = `${required('id')}/insights`; params = { metric: input.metric ?? 'views,likes,replies,reposts,quotes' }; break;
      case 'user_insights': {
        const metric = input.metric ?? 'views,likes,replies,reposts,quotes,followers_count';
        if (metric.split(',').includes('follower_demographics') && !input.breakdown) throw new ThreadsError('INVALID_INPUT', 'follower_demographics requires breakdown');
        path = `${this.#userId}/threads_insights`; params = { metric, since: input.since, until: input.until, breakdown: input.breakdown }; break;
      }
      case 'container_status': path = required('id'); params = { fields: 'id,status,error_message' }; break;
      case 'publishing_limit': path = `${this.#userId}/threads_publishing_limit`; params = { fields: 'quota_usage,config' }; break;
    }
    return this.#result(operation, await this.#request('GET', path, params));
  }
  #writeGuard() {
    if (!this.#writesEnabled) throw new ThreadsError('WRITES_DISABLED', 'Official API writes require the explicit enabled write setting');
    if (this.#userId === 'me') throw new ThreadsError('API_IDENTITY_REQUIRED', 'Configure the exact numeric THREADS_API_USER_ID before preparing writes');
  }
  async #identity() {
    const data = await this.#request('GET', 'me', { fields: 'id,username' });
    if (data.id !== this.#userId || typeof data.username !== 'string') throw new ThreadsError('API_IDENTITY_MISMATCH', 'Token identity does not match the configured Threads API user ID');
    return { id: this.#userId, username: data.username };
  }
  async prepare(raw: OfficialAction): Promise<OfficialPreparedAction> {
    this.#writeGuard();
    const action = this.#parse(officialActionSchema, raw);
    const account = await this.#identity();
    const now = this.#now();
    for (const [key, entry] of this.#prepared) if (entry.expires <= now) this.#prepared.delete(key);
    if (this.#prepared.size >= 100) throw new ThreadsError('API_PREPARED_LIMIT', 'Too many pending prepared actions');
    const expires = now + this.#ttl;
    const value = { preparedId: randomUUID(), expiresAt: new Date(expires).toISOString(), account, action };
    this.#prepared.set(value.preparedId, { value: structuredClone(value), expires });
    return value;
  }
  async execute(preparedId: string): Promise<OfficialMutationResult> {
    this.#writeGuard();
    const entry = this.#prepared.get(preparedId);
    if (!entry) throw new ThreadsError('API_PREPARED_NOT_FOUND', 'Prepared action is absent or already consumed; do not replay uncertain writes');
    this.#prepared.delete(preparedId); // Consume before asynchronous work, including identity recheck.
    if (entry.expires <= this.#now()) throw new ThreadsError('API_PREPARED_EXPIRED', 'Prepared action expired');
    const identity = await this.#identity();
    if (identity.id !== entry.value.account.id || identity.username !== entry.value.account.username) throw new ThreadsError('API_IDENTITY_MISMATCH', 'Account changed after preparation');
    const action = entry.value.action;
    let method: 'POST' | 'DELETE' = 'POST'; let path: string; let params: Params = {};
    switch (action.kind) {
      case 'create_container': {
        path = `${identity.id}/threads`;
        const { children, ...rest } = action.container; params = { ...rest, children: children?.join(',') }; break;
      }
      case 'publish_container': {
        // A read can safely be repeated by callers, publishing cannot. Do not publish a processing/error/already-published container.
        const state = await this.#request('GET', action.creation_id, { fields: 'id,status,error_message' });
        if (state.status !== 'FINISHED') throw new OfficialApiError('API_CONTAINER_NOT_READY', 'Container is not FINISHED; inspect container_status before preparing another publish', 'not_sent');
        path = `${identity.id}/threads_publish`; params = { creation_id: action.creation_id }; break;
      }
      case 'delete_post': method = 'DELETE'; path = action.post_id; break;
      case 'hide_reply': path = `${action.reply_id}/manage_reply`; params = { hide: action.hide }; break;
      case 'manage_pending_reply': path = `${action.reply_id}/manage_pending_reply`; params = { approve: action.approve }; break;
    }
    const data = await this.#request(method, path, params);
    const expectsId = action.kind === 'create_container' || action.kind === 'publish_container';
    if (expectsId ? !id.safeParse(data.id).success : data.success !== true) throw new OfficialApiError('API_MUTATION_UNCONFIRMED', 'API response did not confirm the mutation; inspect account state before any new attempt', 'unknown');
    return { ...this.#result(action.kind, data), outcome: 'api_confirmed', preparedId, accountId: identity.id, action };
  }
}
