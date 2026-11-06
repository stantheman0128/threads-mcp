export type Completeness = 'partial' | 'unknown' | 'complete';
export type ReadSource = 'browser-json' | 'browser-dom' | 'public-html' | 'local-index';
export interface Author { username: string; id?: string; name?: string; verified?: boolean; }
export interface Post {
  id: string;
  code?: string;
  url: string;
  author: Author;
  text: string;
  createdAt: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  views: number | null;
  isReply: boolean | null;
  parentId: string | null;
  rootId: string | null;
  likedByViewer?: boolean | null;
  savedByViewer?: boolean | null;
  media: Array<{ type: 'image' | 'video'; url: string }>;
  observedAt: string;
  source: ReadSource;
}
export interface Profile extends Author {
  bio: string | null;
  followers: number | null;
  following: number | null;
  private: boolean | null;
  url: string;
  links: string[];
}
export interface ReadResult<T> {
  items: T[];
  completeness: Completeness;
  sourceUrl: string;
  observedAt: string;
  warnings: string[];
  evidence: { source: ReadSource; capturedResponses: number; scrollRounds: number };
}
export class ThreadsError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message); this.name = 'ThreadsError';
  }
}
