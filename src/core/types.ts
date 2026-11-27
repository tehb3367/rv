export type DiffLine = {
  kind: 'add' | 'del' | 'ctx';
  oldNo?: number;
  newNo?: number;
  text: string;
  /** Set when the line is followed by "\ No newline at end of file". */
  noNewline?: boolean;
};

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'mode';

export type Hunk = {
  id: string;
  path: string;
  oldPath?: string;
  fileStatus: FileStatus;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** True for binary, pure-rename, mode-only and empty-file pseudo-hunks. */
  pseudo?: boolean;
};

export type Risk = 'low' | 'med' | 'high';

export type Layer = {
  id: string;
  group?: string;
  title: string;
  why: string;
  risk: Risk;
  dependsOn?: string[];
  hunks: string[];
  /** Learning mode: a longer, plain-language explanation for people new to code (at most 2000 characters). */
  explain?: string;
};

export type Plan = { version: 1; title: string; summary?: string; layers: Layer[] };

export type CommentKind = 'review' | 'ask' | 'note' | 'reply';
export type CommentStatus = 'draft' | 'pending' | 'answered' | 'resolved';

export type Comment = {
  id: string;
  hunkId: string;
  line?: { side: 'old' | 'new'; number: number };
  author: 'human' | 'agent';
  kind: CommentKind;
  parentId?: string;
  body: string;
  status: CommentStatus;
  createdAt: string;
  /** Set once an ask has been handed to an agent through `rv wait`. */
  deliveredAt?: string;
  /** Set once a review comment has been posted to GitHub. */
  postedAt?: string;
  /** Set on asks made in learning mode: answer for someone new to code. */
  learning?: boolean;
};

export type SavedState = {
  plan: Plan | null;
  reviewed: Record<string, string>;
  comments: Comment[];
  updatedAt: string;
};

/** What a session diffs. `head` may be the index or the working tree. */
export type DiffSource = {
  repoRoot: string;
  gitDir: string;
  /** Resolved base commit SHA. */
  base: string;
  /** Resolved head commit SHA, or the special values for index / working tree. */
  head: string;
  headMode: 'commit' | 'index' | 'worktree';
  baseLabel: string;
  headLabel: string;
  /** Key used for the saved state file. */
  key: string;
  paths: string[];
  prNumber?: number;
  prUrl?: string;
  prRepo?: string;
};

export type FileSummary = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  hunks: Hunk[];
};

export const UNSTACKED_ID = 'Unstacked';
export const UNPLACED_ID = 'Unplaced';
