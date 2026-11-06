# Local search

`SearchIndex` stores observed posts in `search.sqlite` inside the configured data directory. SQLite uses WAL and a five-second busy timeout. Upserts replace a post only when the incoming observation is at least as recent; text changes naturally invalidate cached vectors. Unknown engagement remains `null`, and `minLikes: 0` excludes unknown values.

All search modes scan the complete stored corpus in pages of 128 rows and retain only the requested top results. There is no hidden recent-post cap. `corpusSize` is the total stored count before author/date/likes filters. Search covers the observed local corpus, not the entire Threads service; collecting more posts must happen through the browser tools first. Concurrent searches within an index are serialized to bound model inference.

- `lexical`: Unicode normalization, Chinese word segmentation and overlapping Han bigrams, plus one-edit Latin typo matching (including adjacent transpositions). The score combines token coverage and exact phrase presence. This is deliberately labeled lexical, not semantic.
- `semantic`: cosine similarity of locally computed multilingual embeddings. Default model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, configurable with `THREADS_EMBEDDING_MODEL`. The first nonempty semantic search downloads the model into `models/` beneath the data directory. Post text is processed locally; it is not sent to an embedding API. ONNX CPU uses quantized `q8` weights, two intra-operation threads and one inter-operation thread.
- `hybrid`: `0.7 * max(0, cosine_similarity) + 0.3 * lexical_score`. Scores are ranking signals, not calibrated confidence.

Long text is split into 80 Unicode-character chunks with 16-character overlap; chunk vectors are averaged and normalized. The native embedder checks tokenizer lengths before inference and rejects a chunk if the model would truncate it. Both queries and post vectors are cached by model/configuration plus SHA-256 of the text. Embeddings are cached, including query embeddings; `stats().embeddings` counts these cached text vectors for the active model configuration.

If a model download or embedding operation fails, the default behavior is an explicitly labeled `lexical-fallback`, with a warning and `semanticScore: null` on every result. A failure halfway through ranking restarts lexical scoring over the entire corpus. Set constructor option `fallbackOnError: false` to receive `EMBEDDINGS_UNAVAILABLE` instead. Underlying errors and private text are not logged or included in the failure message.

For offline tests or another embedding implementation, pass `embedder: async (texts: string[]) => number[][]`, with a distinct `embeddingModel` identifier whenever the vector space changes. Batch size defaults to four and is bounded to 1–16. No model download occurs in the unit tests.

The default model and Transformers.js API are documented at [Hugging Face](https://huggingface.co/docs/transformers.js/en/pipelines). Actual Chinese relevance and retrieval recall still require live evaluation on the user's collected corpus; deterministic fake-vector unit tests establish ranking, persistence, filtering and fallback behavior only.

## Search observed collections and filter results

`index.recordCollection(collection, posts)` atomically upserts posts and records their positive collection membership. Example collection names are `liked`, `saved`, `profile:sample:posts` and `profile:sample:replies`. Names are normalized with Unicode NFKC and lowercase. Recording a collection does not infer that a post is a reply; the observed `Post.isReply` value remains authoritative. Collection timestamps come from each post's `observedAt`, not the time a cached post was indexed.

Membership persists in a separate SQLite table. Opening an existing index adds that table without rebuilding or deleting posts or embeddings. An empty or partial refresh never removes unseen members. Out-of-order observations preserve the earliest and latest collection observation while the newest post payload remains in place.

```ts
index.recordCollection('liked', observedLikedPosts);
const result = await index.search('適合遠端工作的咖啡館', {
  mode: 'hybrid',
  collections: ['liked', 'saved'],
  since: '2026-01-01T00:00:00Z',
  until: '2026-10-23T23:59:59Z',
  excludeTerms: ['業配', 'sponsored'],
  onlyReplies: false,
});
```

- `collections` matches any named collection (OR), combined with the other filters (AND). Omit it to search all stored posts. An explicit empty array matches no posts; unknown names never widen the search.
- `since` and `until` are inclusive bounds on post creation time, not membership observation time. Posts with unknown or invalid creation time cannot pass either bound. Date-only values denote midnight at the start of that date; use an explicit timestamp for an end-of-day cutoff.
- `excludeTerms` removes posts containing any exact substring after Unicode NFKC and lowercase normalization. It matches the post body only; it does not apply typo tolerance, embedding similarity or regex interpretation. Exclusions run before ranking in every mode, including lexical fallback.
- `onlyReplies: true` requires an observed `isReply: true`. `false` requires an observed `isReply: false`; unknown classification is excluded from either explicit filter.
- Hits with known membership include `observedCollections: [{ collection, firstObservedAt, lastObservedAt }]`. These list all known collections for that hit, including collections not selected by the query. `corpusSize` continues to count all stored posts before filters.

Collection membership is historical evidence. A post observed in `liked` or `saved` may since have been unliked, unsaved, deleted or made inaccessible. The index does not claim current membership or a complete liked/saved history; results include that warning. Different signed-in accounts should use distinct collection names or data directories when their liked/saved histories must stay separate.
