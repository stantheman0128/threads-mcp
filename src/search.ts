import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ThreadsError, type Post } from './types.js';

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';
export interface SearchOptions {
  mode: SearchMode;
  limit?: number;
  since?: string;
  until?: string;
  author?: string;
  minLikes?: number;
  /** OR across observed collections; undefined searches all posts, [] matches none. */
  collections?: string[];
  excludeTerms?: string[];
  /** Both true and false exclude unknown reply classification. */
  onlyReplies?: boolean;
  /** Enforced while retaining top results, so prolific authors cannot hide other candidates. */
  maxPerAuthor?: number;
  /** Internal text eligibility for mention discovery; does not establish identity for name matches. */
  mentionFilter?: { username: string; terms?: string[]; excludeSelf?: boolean };
}
export interface MentionClassification { kind: 'explicit-handle' | 'name-or-brand-candidate'; matchedTerms: string[] }
export interface CollectionObservation { collection: string; firstObservedAt: string; lastObservedAt: string }
export interface SearchHit {
  post: Post;
  score: number;
  lexicalScore: number;
  semanticScore: number | null;
  observedCollections?: CollectionObservation[];
}
export interface SearchResult {
  items: SearchHit[];
  method: string;
  warnings: string[];
  corpusSize: number;
}
export interface SearchIndexOptions {
  /** Tests and alternate local models can inject batch embeddings without downloads. */
  embedder?: (texts: string[]) => Promise<number[][]>;
  /** Use a distinct name when changing an injected embedder's vector space. */
  embeddingModel?: string;
  batchSize?: number;
  fallbackOnError?: boolean;
}

const DEFAULT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const CORPUS_WARNING = 'Results cover only locally observed posts, not all of Threads or complete account history.';
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en').trim();
const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
function collectionName(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ThreadsError('INVALID_ARGUMENT', 'Collection names require 1 to 200 characters without control characters.');
  }
  return normalize(value);
}

function mentionMatcher(username: string, terms: string[] = []): (text: string) => MentionClassification | null {
  if (typeof username !== 'string') throw new ThreadsError('INVALID_ARGUMENT', 'Mention matching requires a Threads username.');
  const name = username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9._]{1,64}$/.test(name)) throw new ThreadsError('INVALID_ARGUMENT', 'Mention matching requires a valid Threads username.');
  if (!Array.isArray(terms) || terms.length > 64 || terms.some(term => typeof term !== 'string' || !term.trim() || term.length > 256)) {
    throw new ThreadsError('INVALID_ARGUMENT', 'Mention terms require at most 64 nonempty strings of up to 256 characters.');
  }
  const uniqueTerms = [...new Map(terms.map(term => [normalize(term), term.trim()])).entries()];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ASCII email/username prefixes and @@ are not mentions. Chinese text may directly precede @.
  const explicit = new RegExp(`(?<![a-z0-9._%+@-])@${escaped}(?![a-z0-9._])`, 'i');
  return text => {
    const folded = normalize(text);
    const matchedTerms = uniqueTerms.filter(([term]) => folded.includes(term)).map(([, original]) => original);
    if (explicit.test(text)) return { kind: 'explicit-handle', matchedTerms: [`@${name}`, ...matchedTerms] };
    return matchedTerms.length ? { kind: 'name-or-brand-candidate', matchedTerms } : null;
  };
}

/** Text evidence only: an explicit handle token or a separately labeled name/brand candidate. */
export function classifyMentionText(text: string, username: string, terms: string[] = []): MentionClassification | null {
  return mentionMatcher(username, terms)(text);
}

/** Word segmentation plus overlapping Han bigrams preserve Chinese phrase matches. */
function tokens(text: string): string[] {
  const value = normalize(text);
  const result = new Set<string>();
  for (const part of SEGMENTER.segment(value)) if (part.isWordLike) result.add(part.segment);
  for (const match of value.matchAll(/\p{Script=Han}+/gu)) {
    const chars = [...match[0]];
    for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
  }
  return [...result];
}

/** One edit, including a neighbouring transposition, for Latin words only. */
function nearWord(a: string, b: string): boolean {
  if (!/^[a-z]{4,}$/u.test(a) || !/^[a-z]{3,}$/u.test(b) || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differences: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differences.push(i);
    return differences.length === 1 || (differences.length === 2 && differences[1] === differences[0] + 1 &&
      a[differences[0]] === b[differences[1]] && a[differences[1]] === b[differences[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

function lexical(query: string, queryTokens: string[], post: Post): number {
  const text = normalize(`${post.text} ${post.author.username} ${post.author.name ?? ''}`);
  const words = tokens(text);
  const set = new Set(words);
  let sum = 0;
  for (const word of queryTokens) {
    if (set.has(word)) sum += 1;
    else if (words.some(candidate => nearWord(word, candidate))) sum += 0.7;
  }
  const coverage = queryTokens.length ? sum / queryTokens.length : 0;
  return Math.min(1, coverage * 0.85 + (text.includes(normalize(query)) ? 0.15 : 0));
}

function unitVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value))) {
    throw new Error('Embedding returned an invalid vector');
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error('Embedding returned a zero vector');
  return vector.map(value => value / norm);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('Embedding dimensions changed');
  return Math.max(-1, Math.min(1, a.reduce((sum, value, index) => sum + value * b[index], 0)));
}

/** Conservative chunks avoid silently truncating long posts at the model token limit. */
function chunks(text: string): string[] {
  const chars = [...text];
  const result: string[] = [];
  // At most 80 Unicode characters per chunk; multilingual subword tokenization can expand this.
  for (let offset = 0; offset < chars.length; offset += 64) result.push(chars.slice(offset, offset + 80).join(''));
  return result.length ? result : [' '];
}

interface Row { rowid: number; payload: string; text_hash: string }

export class SearchIndex {
  private readonly db: DatabaseSync;
  private readonly model: string;
  private readonly cacheKey: string;
  private readonly batchSize: number;
  private readonly options: SearchIndexOptions;
  private readonly modelDir: string;
  private embedderPromise?: Promise<(texts: string[]) => Promise<number[][]>>;
  private disposePipeline?: () => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(dataDir: string, options: SearchIndexOptions = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.options = options;
    this.model = options.embeddingModel ?? process.env.THREADS_EMBEDDING_MODEL ?? DEFAULT_MODEL;
    this.cacheKey = `${this.model}:q8:mean:chunks80-overlap16:v1${options.embedder ? ':injected' : ''}`;
    this.batchSize = Math.max(1, Math.min(16, Math.floor(options.batchSize ?? 4)));
    if (!Number.isFinite(this.batchSize)) throw new ThreadsError('INVALID_ARGUMENT', 'batchSize must be finite.');
    this.modelDir = join(dataDir, 'models');
    this.db = new DatabaseSync(join(dataDir, 'search.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, text_hash TEXT NOT NULL,
        author TEXT NOT NULL, created_at TEXT, likes INTEGER, observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS posts_author ON posts(author);
      CREATE TABLE IF NOT EXISTS embeddings (
        model TEXT NOT NULL, text_hash TEXT NOT NULL, vector TEXT NOT NULL,
        PRIMARY KEY(model, text_hash)
      );
      CREATE TABLE IF NOT EXISTS collection_memberships (
        collection TEXT NOT NULL, post_id TEXT NOT NULL REFERENCES posts(id),
        first_observed_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
        PRIMARY KEY(collection, post_id)
      );
      CREATE INDEX IF NOT EXISTS collection_memberships_post ON collection_memberships(post_id);
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new ThreadsError('INDEX_CLOSED', 'Search index is closed.');
  }

  upsert(posts: Post[]): void {
    this.savePosts(posts);
  }

  /** Records positive observations only; absence from a partial refresh never removes membership. */
  recordCollection(collection: string, posts: Post[]): void {
    this.savePosts(posts, collectionName(collection));
  }

  /** Explicit correction of known misclassified membership, never inferred from partial absence. */
  removeCollectionMembers(collection: string, postIds: string[]): number {
    this.assertOpen();
    const name = collectionName(collection);
    if (!Array.isArray(postIds) || postIds.some(id => typeof id !== 'string' || !id.length)) {
      throw new ThreadsError('INVALID_ARGUMENT', 'Membership removal requires an explicit array of nonempty post ids.');
    }
    const statement = this.db.prepare('DELETE FROM collection_memberships WHERE collection=? AND post_id=?');
    let removed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of new Set(postIds)) removed += Number(statement.run(name, id).changes);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private savePosts(posts: Post[], collection?: string): void {
    this.assertOpen();
    const statement = this.db.prepare(`INSERT INTO posts
      (id, payload, text_hash, author, created_at, likes, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, text_hash=excluded.text_hash,
      author=excluded.author, created_at=excluded.created_at, likes=excluded.likes, observed_at=excluded.observed_at
      WHERE julianday(excluded.observed_at) >= julianday(posts.observed_at)`);
    const membership = collection === undefined ? undefined : this.db.prepare(`INSERT INTO collection_memberships
      (collection, post_id, first_observed_at, last_observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(collection, post_id) DO UPDATE SET
      first_observed_at = CASE WHEN julianday(excluded.first_observed_at) < julianday(collection_memberships.first_observed_at)
        THEN excluded.first_observed_at ELSE collection_memberships.first_observed_at END,
      last_observed_at = CASE WHEN julianday(excluded.last_observed_at) > julianday(collection_memberships.last_observed_at)
        THEN excluded.last_observed_at ELSE collection_memberships.last_observed_at END`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const post of posts) {
        if (!post.id || !Number.isFinite(Date.parse(post.observedAt))) {
          throw new ThreadsError('INVALID_POST', 'Indexed posts require an id and valid observedAt timestamp.');
        }
        statement.run(post.id, JSON.stringify(post), hashText(post.text), normalize(post.author.username),
          post.createdAt, post.likes, post.observedAt);
        if (membership) {
          const observedAt = new Date(post.observedAt).toISOString();
          membership.run(collection!, post.id, observedAt, observedAt);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stats(): { posts: number; embeddings: number; embeddingModel: string; scope: string } {
    this.assertOpen();
    const posts = Number(this.db.prepare('SELECT count(*) AS n FROM posts').get()!.n);
    const embeddings = Number(this.db.prepare('SELECT count(*) AS n FROM embeddings WHERE model=?').get(this.cacheKey)!.n);
    return { posts, embeddings, embeddingModel: this.model, scope: 'locally-observed-posts' };
  }

  search(query: string, options: SearchOptions): Promise<SearchResult> {
    // Serialize model execution and cache operations across concurrent MCP requests.
    const task = this.queue.then(() => this.performSearch(query, options));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async getEmbedder(): Promise<(texts: string[]) => Promise<number[][]>> {
    this.embedderPromise ??= (async () => {
      if (this.options.embedder) return this.options.embedder;
      const { pipeline, env, LogLevel } = await import('@huggingface/transformers');
      env.logLevel = LogLevel.NONE;
      mkdirSync(this.modelDir, { recursive: true });
      const extractor = await pipeline('feature-extraction', this.model, {
        dtype: 'q8', device: 'cpu', cache_dir: this.modelDir,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 4 },
      });
      this.disposePipeline = async () => { await extractor.dispose(); };
      return async (texts: string[]) => {
        const full = extractor.tokenizer(texts, { padding: true, truncation: false });
        const bounded = extractor.tokenizer(texts, { padding: true, truncation: true });
        if (full.input_ids.dims[1] !== bounded.input_ids.dims[1]) throw new Error('Model would truncate an embedding chunk');
        const result = await extractor(texts, { pooling: 'mean', normalize: true });
        return result.tolist() as number[][];
      };
    })();
    try { return await this.embedderPromise; }
    catch (error) { this.embedderPromise = undefined; throw error; }
  }

  private async vector(text: string, hash: string): Promise<number[]> {
    this.assertOpen();
    const cached = this.db.prepare('SELECT vector FROM embeddings WHERE model=? AND text_hash=?').get(this.cacheKey, hash);
    if (cached) return unitVector(JSON.parse(String(cached.vector)) as number[]);
    const embed = await this.getEmbedder();
    const parts = chunks(text);
    let aggregate: number[] | undefined;
    for (let offset = 0; offset < parts.length; offset += this.batchSize) {
      const batch = parts.slice(offset, offset + this.batchSize);
      const vectors = await embed(batch);
      this.assertOpen();
      if (vectors.length !== batch.length) throw new Error('Embedding batch length mismatch');
      for (const raw of vectors) {
        const vector = unitVector(raw);
        aggregate ??= Array<number>(vector.length).fill(0);
        if (aggregate.length !== vector.length) throw new Error('Embedding dimensions changed');
        vector.forEach((value, i) => { aggregate![i] += value; });
      }
    }
    const result = unitVector(aggregate!);
    this.db.prepare('INSERT OR REPLACE INTO embeddings (model, text_hash, vector) VALUES (?, ?, ?)')
      .run(this.cacheKey, hash, JSON.stringify(result));
    return result;
  }

  private async performSearch(query: string, options: SearchOptions): Promise<SearchResult> {
    this.assertOpen();
    if (!query.trim() || query.length > 4096) throw new ThreadsError('INVALID_ARGUMENT', 'Query must contain 1 to 4096 characters.');
    if (!['lexical', 'semantic', 'hybrid'].includes(options.mode)) throw new ThreadsError('INVALID_ARGUMENT', 'Unknown search mode.');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ThreadsError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 200.');
    if (options.since !== undefined && !Number.isFinite(Date.parse(options.since))) throw new ThreadsError('INVALID_ARGUMENT', 'since must be a valid date.');
    if (options.until !== undefined && !Number.isFinite(Date.parse(options.until))) throw new ThreadsError('INVALID_ARGUMENT', 'until must be a valid date.');
    if (options.since !== undefined && options.until !== undefined && Date.parse(options.since) > Date.parse(options.until)) {
      throw new ThreadsError('INVALID_ARGUMENT', 'since must not be later than until.');
    }
    if (options.collections !== undefined && (!Array.isArray(options.collections) || options.collections.length > 64)) {
      throw new ThreadsError('INVALID_ARGUMENT', 'collections must be an array of at most 64 collection names.');
    }
    const collections = options.collections === undefined ? undefined : [...new Set(options.collections.map(collectionName))];
    if (options.excludeTerms !== undefined && (!Array.isArray(options.excludeTerms) || options.excludeTerms.length > 64 ||
      options.excludeTerms.some(term => typeof term !== 'string' || !term.trim() || term.length > 256))) {
      throw new ThreadsError('INVALID_ARGUMENT', 'excludeTerms must contain at most 64 nonempty strings of up to 256 characters.');
    }
    const excluded = options.excludeTerms?.map(normalize) ?? [];
    if (options.onlyReplies !== undefined && typeof options.onlyReplies !== 'boolean') throw new ThreadsError('INVALID_ARGUMENT', 'onlyReplies must be a boolean.');
    if (options.maxPerAuthor !== undefined && (!Number.isInteger(options.maxPerAuthor) || options.maxPerAuthor < 1 || options.maxPerAuthor > 200)) {
      throw new ThreadsError('INVALID_ARGUMENT', 'maxPerAuthor must be an integer from 1 to 200.');
    }
    if (options.mentionFilter !== undefined && (!options.mentionFilter || typeof options.mentionFilter !== 'object')) {
      throw new ThreadsError('INVALID_ARGUMENT', 'mentionFilter requires a username and optional terms.');
    }
    const classifyMention = options.mentionFilter ? mentionMatcher(options.mentionFilter.username, options.mentionFilter.terms) : undefined;
    if (options.mentionFilter?.excludeSelf !== undefined && typeof options.mentionFilter.excludeSelf !== 'boolean') {
      throw new ThreadsError('INVALID_ARGUMENT', 'mentionFilter.excludeSelf must be a boolean.');
    }
    const excludeMentionAuthor = options.mentionFilter?.excludeSelf ? normalize(options.mentionFilter.username.trim().replace(/^@/, '')) : undefined;
    if (options.minLikes !== undefined && (!Number.isFinite(options.minLikes) || options.minLikes < 0)) {
      throw new ThreadsError('INVALID_ARGUMENT', 'minLikes must be a nonnegative number.');
    }
    const corpusSize = this.stats().posts;
    const warnings = [CORPUS_WARNING];
    const queryTokens = tokens(query);
    let method: string = options.mode === 'lexical' ? 'lexical-word-bigram-typo' : `${options.mode}-multilingual-embeddings`;
    let queryVector: number[] | null = null;
    const fallback = () => {
      if (this.options.fallbackOnError === false) throw new ThreadsError('EMBEDDINGS_UNAVAILABLE', 'Local embeddings are unavailable. Retry after checking model availability, or use lexical mode.');
      method = 'lexical-fallback';
      warnings.push('Local embeddings were unavailable or invalid. These results use lexical matching only; no semantic ranking was performed.');
      queryVector = null;
    };
    if (options.mode !== 'lexical' && corpusSize && collections?.length !== 0) {
      try { queryVector = await this.vector(query, hashText(query)); }
      catch { this.assertOpen(); fallback(); }
    }
    const maxRow = Number(this.db.prepare('SELECT coalesce(max(rowid), 0) AS n FROM posts').get()!.n);
    const scopeClause = collections === undefined ? '' : collections.length === 0 ? ' AND 0' :
      ` AND EXISTS (SELECT 1 FROM collection_memberships cm WHERE cm.post_id=p.id AND cm.collection IN (${collections.map(() => '?').join(',')}))`;
    const scanStatement = this.db.prepare(`SELECT p.rowid, p.payload, p.text_hash FROM posts p
      WHERE p.rowid > ? AND p.rowid <= ?${scopeClause} ORDER BY p.rowid LIMIT 128`);
    const scan = async (): Promise<SearchHit[]> => {
      const hits: Array<SearchHit & { mentionPriority: number }> = [];
      let cursor = 0;
      while (cursor < maxRow) {
        this.assertOpen();
        const rows = scanStatement.all(cursor, maxRow, ...(collections ?? [])) as unknown as Row[];
        if (!rows.length) break;
        for (const row of rows) {
          cursor = row.rowid;
          const post = JSON.parse(row.payload) as Post;
          if (options.author && normalize(post.author.username) !== normalize(options.author.replace(/^@/, ''))) continue;
          if (options.minLikes !== undefined && (post.likes === null || post.likes < options.minLikes)) continue;
          if (options.since && (!post.createdAt || !(Date.parse(post.createdAt) >= Date.parse(options.since)))) continue;
          if (options.until && (!post.createdAt || !(Date.parse(post.createdAt) <= Date.parse(options.until)))) continue;
          if (options.onlyReplies !== undefined && post.isReply !== options.onlyReplies) continue;
          if (excluded.length && excluded.some(term => normalize(post.text).includes(term))) continue;
          if (excludeMentionAuthor && normalize(post.author.username) === excludeMentionAuthor) continue;
          const mention = classifyMention?.(post.text);
          if (classifyMention && !mention) continue;
          const lexicalScore = lexical(query, queryTokens, post);
          const semanticScore = queryVector ? cosine(queryVector, await this.vector(post.text, row.text_hash)) : null;
          const score = semanticScore === null ? lexicalScore : options.mode === 'semantic' ? semanticScore :
            0.7 * Math.max(0, semanticScore) + 0.3 * lexicalScore;
          if (semanticScore === null && score <= 0 && !mention) continue;
          hits.push({ post, score, lexicalScore, semanticScore, mentionPriority: mention?.kind === 'explicit-handle' ? 1 : 0 });
          hits.sort((a, b) => b.mentionPriority - a.mentionPriority || b.score - a.score || a.post.id.localeCompare(b.post.id));
          if (options.maxPerAuthor !== undefined) {
            const author = normalize(post.author.username);
            let count = 0;
            // Only the newly inserted author's count can exceed its cap.
            const worst = hits.findIndex(hit => normalize(hit.post.author.username) === author && ++count > options.maxPerAuthor!);
            if (worst >= 0) hits.splice(worst, 1);
          }
          if (hits.length > limit) hits.pop();
        }
      }
      return hits.map(({ mentionPriority: _priority, ...hit }) => hit);
    };
    let items: SearchHit[];
    try { items = await scan(); }
    catch (error) {
      this.assertOpen();
      if (!queryVector) throw error;
      fallback();
      items = await scan(); // Re-rank the entire corpus; do not mix partial semantic and lexical scores.
    }
    if (!corpusSize) warnings.push('The local corpus is empty. Collect posts with browser search or profile/post reads first.');
    if (queryVector) warnings.push('Similarity scores are ranking signals, not factual confidence or proof of relevance.');
    if (classifyMention) warnings.push('Explicit handle text is prioritized before name/brand candidates. Name/brand matches are not identity proof; ranking scores retain their original meaning.');
    const observations = this.db.prepare(`SELECT collection, first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt
      FROM collection_memberships WHERE post_id=? ORDER BY collection`);
    for (const item of items) {
      const membership = observations.all(item.post.id) as unknown as CollectionObservation[];
      if (membership.length) item.observedCollections = membership.map(observation => ({ ...observation }));
    }
    if (collections !== undefined || items.some(item => item.observedCollections?.length)) {
      warnings.push('Collection membership is a historical positive observation. Partial refreshes retain unseen members; liked or saved membership does not prove that a post is currently liked or saved.');
    }
    return { items, method, warnings, corpusSize };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    void this.disposePipeline?.().catch(() => undefined);
  }
}
