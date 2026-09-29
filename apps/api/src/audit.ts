/**
 * The audit log (§16): an append-only record of what a person did that
 * matters later — credentials created, replaced, deleted; a run's results
 * accepted as a baseline. Separate from run logs on purpose: this is the
 * record someone asks for when a number changed and they want to know who
 * changed it. Never holds a secret value — only names and ids.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { JsonValue } from '@goblin/spec';

export interface AuditEvent {
  at: string;
  /** Local mode has one person; the field is here so Stage 8 only fills it in. */
  actor: string;
  action: string;
  subject: string;
  detail?: JsonValue;
}

export interface AuditLog {
  record(event: Omit<AuditEvent, 'at' | 'actor'> & { actor?: string }): Promise<void>;
}

export class FileAuditLog implements AuditLog {
  constructor(private readonly path: string) {}

  async record(event: Omit<AuditEvent, 'at' | 'actor'> & { actor?: string }): Promise<void> {
    const line: AuditEvent = { at: new Date().toISOString(), actor: event.actor ?? 'local', action: event.action, subject: event.subject, ...(event.detail !== undefined ? { detail: event.detail } : {}) };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];
  async record(event: Omit<AuditEvent, 'at' | 'actor'> & { actor?: string }): Promise<void> {
    this.events.push({ at: new Date().toISOString(), actor: event.actor ?? 'local', action: event.action, subject: event.subject, ...(event.detail !== undefined ? { detail: event.detail } : {}) });
  }
}
