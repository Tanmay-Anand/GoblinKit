import type { WorkflowDocument } from '@goblin/spec';

/**
 * Undo and redo, as document snapshots.
 *
 * Every command produces a new immutable document, so the step before is a
 * snapshot that already exists — keeping it costs a pointer, not a copy. That
 * makes undo exact for every command, including ones added later, with no
 * hand-written inverse to fall out of step with its command.
 *
 * Typing in a settings field produces a command per keystroke. Steps that
 * share a `coalesceKey` and arrive close together merge into one, so undo
 * takes back the whole word rather than the last letter.
 */

interface Step {
  before: WorkflowDocument;
  after: WorkflowDocument;
  coalesceKey?: string;
  at: number;
}

const COALESCE_MS = 1200;
const LIMIT = 200;

export class History {
  private past: Step[] = [];
  private future: Step[] = [];

  record(before: WorkflowDocument, after: WorkflowDocument, coalesceKey?: string, now = Date.now()): void {
    if (before === after) return;
    const last = this.past.at(-1);
    if (coalesceKey && last?.coalesceKey === coalesceKey && now - last.at < COALESCE_MS && last.after === before) {
      last.after = after;
      last.at = now;
    } else {
      this.past.push({ before, after, at: now, ...(coalesceKey ? { coalesceKey } : {}) });
      if (this.past.length > LIMIT) this.past.shift();
    }
    this.future = [];
  }

  /** Returns the document to show, or undefined if there is nothing to undo. */
  undo(): WorkflowDocument | undefined {
    const step = this.past.pop();
    if (!step) return undefined;
    this.future.push(step);
    return step.before;
  }

  redo(): WorkflowDocument | undefined {
    const step = this.future.pop();
    if (!step) return undefined;
    this.past.push(step);
    return step.after;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
