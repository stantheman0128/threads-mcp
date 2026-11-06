import type { Post, Profile, ReadSource } from './types.js';
import { sameId } from './urls.js';

type Obj = Record<string, any>;
type Candidate = { post: Post; path: string; replyContextRoot?: string; bundle: string[] };
export interface ParsedData { posts: Post[]; profiles: Profile[]; replies: Post[]; warnings: string[]; }
const number = (...values: unknown[]): number | null => {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  return null;
};
const id = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null);
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
function object(value: unknown): value is Obj { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}

export function normalizePost(value: unknown, source: ReadSource = 'browser-json', observedAt = new Date().toISOString()): Post | null {
  if (!object(value)) return null;
  const user = value.user || value.owner;
  const code = text(value.code || value.shortcode);
  const username = text(user?.username);
  const postId = id(value.pk) || id(value.id);
  if (!postId || !code || !/^[\w-]+$/.test(code) || !/^[\w.]+$/.test(username)) return null;
  const app = object(value.text_post_app_info) ? value.text_post_app_info : {};
  const fragments = app.text_fragments?.fragments;
  const caption = text(value.caption?.text) || text(value.text) || (Array.isArray(fragments) ? fragments.map(x => text(x?.plaintext)).join('') : '');
  const media: Post['media'] = [];
  for (const item of Array.isArray(value.carousel_media) ? value.carousel_media : [value]) {
    const video = safeMediaUrl(item.video_versions?.[0]?.url);
    const image = safeMediaUrl(item.image_versions2?.candidates?.[0]?.url);
    if (video) media.push({ type: 'video', url: video });
    else if (image) media.push({ type: 'image', url: image });
  }
  let createdAt: string | null = null;
  const unix = number(value.taken_at, value.timestamp);
  if (unix !== null) { const date = new Date(unix < 1e12 ? unix * 1000 : unix); if (Number.isFinite(date.valueOf())) createdAt = date.toISOString(); }
  const parentId = id(app.reply_to_id) || id(value.reply_to_id) || id(value.replied_to?.id) || id(app.replied_to?.id);
  const rootId = id(app.root_post?.id) || id(value.root_post?.id) || id(app.root_post_id);
  return {
    id: postId, code, url: `https://www.threads.com/@${username}/post/${code}`,
    author: { username, ...(id(user.pk || user.id) ? { id: id(user.pk || user.id)! } : {}), ...(text(user.full_name) ? { name: text(user.full_name) } : {}), ...(typeof user.is_verified === 'boolean' ? { verified: user.is_verified } : {}) },
    text: caption, createdAt,
    likes: value.like_and_view_counts_disabled === true ? null : number(value.like_count),
    replies: number(app.direct_reply_count, value.reply_count), reposts: number(app.repost_count, value.repost_count),
    quotes: number(app.quote_count, value.quote_count), views: value.like_and_view_counts_disabled === true ? null : number(value.view_count, value.view_counts),
    isReply: bool(app.is_reply ?? value.is_reply), parentId, rootId, likedByViewer: bool(value.has_liked), savedByViewer: bool(value.has_viewer_saved), media, observedAt, source,
  };
}

export function normalizeProfile(value: unknown): Profile | null {
  if (!object(value) || typeof value.username !== 'string' || !/^[\w.]+$/.test(value.username)) return null;
  // Do not mistake a random username-bearing object or a post for a profile.
  if (!['pk','id','full_name','biography','follower_count','text_post_app_is_private'].some(k => k in value)) return null;
  const links = Array.isArray(value.bio_links) ? value.bio_links.map(x => safeMediaUrl(x?.url)).filter((x): x is string => !!x) : [];
  return {
    username: value.username, ...(id(value.pk || value.id) ? { id: id(value.pk || value.id)! } : {}),
    ...(text(value.full_name) ? { name: text(value.full_name) } : {}),
    ...(typeof value.is_verified === 'boolean' ? { verified: value.is_verified } : {}),
    bio: typeof value.biography === 'string' ? value.biography : null,
    followers: number(value.follower_count), following: number(value.following_count),
    private: bool(value.text_post_app_is_private ?? value.is_private),
    url: `https://www.threads.com/@${value.username}`, links,
  };
}

function mergePost(old: Post, next: Post): Post {
  const merged = { ...old };
  for (const [key,value] of Object.entries(next)) if (value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) (merged as any)[key] = value;
  return merged;
}
export function dedupePosts(posts: Post[]): Post[] {
  const map = new Map<string, Post>();
  for (const post of posts) { const key = post.code || post.id; map.set(key, map.has(key) ? mergePost(map.get(key)!,post) : post); }
  return [...map.values()];
}

export function parsePayloads(payloads: unknown[], options: {rootCode?: string; source?: ReadSource; observedAt?: string} = {}): ParsedData {
  const candidates: Candidate[] = [];
  const profiles = new Map<string, Profile>();
  const observedAt = options.observedAt || new Date().toISOString();
  const seen = new WeakSet<object>();
  let visited = 0;
  function walk(value: unknown, path: string, replyContextRoot: string | undefined = undefined, bundle: string[] = [], depth = 0, scopeRoot?: string) {
    if (!value || typeof value !== 'object' || depth > 65 || visited++ > 150_000 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((v,i) => walk(v,`${path}[${i}]`,replyContextRoot,bundle,depth+1,scopeRoot)); return; }
    const obj = value as Obj;
    const post = normalizePost(obj,options.source,observedAt);
    // A replies key alone is not evidence that its children belong to the requested post.
    // Anchor recognized conversation containers to their actual root before inheriting context.
    // Threads also delivers replies in a separate media fragment containing only
    // id + text_post_app_info, without the root's code/user fields.
    const mediaFragmentId = object(obj.text_post_app_info) ? id(obj.id) || id(obj.pk) : null;
    const containerRoot = post?.code || obj.post?.code || obj.thread_items?.[0]?.post?.code || obj.containing_thread?.thread_items?.[0]?.post?.code || mediaFragmentId;
    const nextScope = typeof containerRoot === 'string' ? containerRoot : scopeRoot;
    const profile = normalizeProfile(obj);
    if (profile) {
      const prev = profiles.get(profile.username);
      profiles.set(profile.username, prev ? Object.fromEntries(Object.keys({...prev,...profile}).map(k => [k, (profile as any)[k] ?? (prev as any)[k]])) as unknown as Profile : profile);
    }
    if (post) candidates.push({post,path,replyContextRoot,bundle});
    for (const [key,child] of Object.entries(obj)) {
      // Recommendations and quoted originals are not members of the requested feed/conversation.
      if (/^(relatedPosts|related_posts|suggested_posts|suggestedUsers|suggested_users|share_info|quoted_post|quoted_attachment|quoted_attachment_post|reposted_post)$/.test(key)) continue;
      const nextReplyRoot = /^(direct_replies|reply_threads|replies|reply_connection|thread_replies|replies_connection)$/i.test(key)
        ? (replyContextRoot ?? nextScope) : replyContextRoot;
      if (key === 'thread_items' && Array.isArray(child)) {
        const codes = child.map(x => x?.post?.code).filter((x): x is string => typeof x === 'string');
        walk(child,`${path}.${key}`,nextReplyRoot,codes,depth+1,nextScope);
      } else walk(child,`${path}.${key}`,nextReplyRoot,bundle,depth+1,nextScope);
    }
  }
  payloads.forEach((payload,i) => walk(payload,`payload[${i}]`));
  const posts = dedupePosts(candidates.map(x => x.post));
  const root = options.rootCode ? posts.find(p => p.code === options.rootCode) : undefined;
  const replies = root ? dedupePosts(candidates.filter(c => c.post.code !== root.code && (
    sameId(c.post.rootId,root.id) || sameId(c.post.parentId,root.id) ||
    ((!c.post.rootId || sameId(c.post.rootId, root.id)) &&
      (c.replyContextRoot === root.code || sameId(c.replyContextRoot,root.id) || (c.bundle.includes(root.code!) && c.post.isReply === true)))
  )).map(c => ({...c.post, rootId: c.post.rootId || root.id}))) : [];
  return { posts, profiles: [...profiles.values()], replies, warnings: visited > 150_000 ? ['Payload traversal limit reached; result is partial.'] : [] };
}

export function parseWire(text: string): unknown[] {
  const clean = text.replace(/^for\s*\(;;\);\s*/, '').trim();
  try { return [JSON.parse(clean)]; } catch { return clean.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
}

export function parseCount(value: string | null): number | null {
  if (!value) return null;
  const match = value.replace(/,/g,'').match(/(\d+(?:\.\d+)?)\s*([KMB萬万億亿])?/i);
  if (!match) return null;
  const scale: Record<string,number> = {k:1000,m:1e6,b:1e9,'萬':1e4,'万':1e4,'億':1e8,'亿':1e8};
  return Math.round(Number(match[1]) * (scale[(match[2] || '').toLowerCase()] || 1));
}
