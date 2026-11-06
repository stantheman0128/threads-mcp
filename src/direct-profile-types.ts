import type { Post, Profile } from './types.js';

export interface DirectProfileArgs { username: string; maxPages: number; pageSize: number; }

export type DirectProfileStopReason = 'page_limit' | 'end_of_connection' | 'cursor_missing' |
  'cursor_loop' | 'no_progress' | 'binding_unavailable' | 'schema_unavailable' |
  'query_unavailable' | 'http_rejected' | 'graphql_error' | 'request_failed' |
  'response_limit' | 'time_limit' | 'context_changed' | 'cancelled';

export interface DirectProfileResult {
  profile: Profile | null;
  items: Post[];
  contextualPosts: Post[];
  sourceUrl: string;
  observedAt: string;
  completeness: 'partial';
  warnings: string[];
  pagination: {
    provider: 'direct';
    pagesFetched: number;
    requests: number;
    uniquePosts: number;
    hasNext: boolean | null;
    stopReason: DirectProfileStopReason;
    pages: Array<{ page: number; received: number; added: number; cursorAdvanced: boolean | null }>;
  };
}
