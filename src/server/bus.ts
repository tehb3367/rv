export type NavigateTarget = { layer?: string; hunk?: string; comment?: string };

export type SessionEvent =
  | { type: 'plan' }
  | { type: 'comments'; hunkIds: string[] }
  | { type: 'reviewed'; hunkIds: string[] }
  | { type: 'navigate'; target: NavigateTarget }
  | { type: 'reload' }
  | { type: 'agent'; waiting: boolean }
  | { type: 'done' };

type Handler = (e: SessionEvent) => void;

/** In-process event bus between the session server and the TUI. */
export class EventBus {
  private handlers = new Set<Handler>();

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  emit(e: SessionEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(e);
      } catch {
        /* a broken listener must not break the server */
      }
    }
  }
}
