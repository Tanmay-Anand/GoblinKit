/**
 * When a Schedule box fires.
 *
 * Every schedule, friendly or not, becomes one five-field cron rule —
 * "every 15 minutes" is `*\/15 * * * *` — so there is exactly one piece of
 * next-fire logic to get right. Times are the machine's local time: this is
 * a local app, and "every day at 09:00" means nine o'clock where you are.
 *
 * Pure: no clock is read here. The caller says "after when".
 */

import type { JsonValue } from '@goblin/spec';

export type Repeat = 'minutes' | 'hours' | 'day' | 'week' | 'cron';
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export interface ScheduleSettings {
  repeat: Repeat;
  every: number;
  at: string;
  weekday: string;
  cron: string;
}

/** Read a Schedule box's settings, with defaults filled in. */
export function scheduleSettings(config: Record<string, JsonValue | undefined>): ScheduleSettings {
  return {
    repeat: (typeof config['repeat'] === 'string' ? config['repeat'] : 'minutes') as Repeat,
    every: typeof config['every'] === 'number' ? config['every'] : 15,
    at: typeof config['at'] === 'string' ? config['at'] : '09:00',
    weekday: typeof config['weekday'] === 'string' ? config['weekday'] : 'Monday',
    cron: typeof config['cron'] === 'string' ? config['cron'] : '',
  };
}

/** The settings as a cron rule, or the reason they cannot be one. */
export function toCron(s: ScheduleSettings): { cron: string } | { problem: string } {
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.at.trim());
  switch (s.repeat) {
    case 'minutes':
      if (!Number.isInteger(s.every) || s.every < 1 || s.every > 59) return { problem: 'Every how many minutes must be a whole number from 1 to 59.' };
      return { cron: `*/${s.every} * * * *` };
    case 'hours':
      if (!Number.isInteger(s.every) || s.every < 1 || s.every > 23) return { problem: 'Every how many hours must be a whole number from 1 to 23.' };
      return { cron: `0 */${s.every} * * *` };
    case 'day':
      if (!clock) return { problem: `"${s.at}" is not a time. Use 24-hour HH:MM, like 09:30.` };
      return { cron: `${Number(clock[2])} ${Number(clock[1])} * * *` };
    case 'week': {
      if (!clock) return { problem: `"${s.at}" is not a time. Use 24-hour HH:MM, like 09:30.` };
      const day = WEEKDAYS.indexOf(s.weekday as (typeof WEEKDAYS)[number]);
      if (day < 0) return { problem: `"${s.weekday}" is not a day of the week.` };
      return { cron: `${Number(clock[2])} ${Number(clock[1])} * * ${day}` };
    }
    case 'cron': {
      const parsed = parseCron(s.cron);
      return 'problem' in parsed ? parsed : { cron: s.cron.trim() };
    }
    default:
      return { problem: `"${String(s.repeat)}" is not a way this box knows to repeat.` };
  }
}

/** A plain sentence for the canvas: "Every 15 minutes", "Every Monday at 09:00". */
export function describeSchedule(s: ScheduleSettings): string {
  switch (s.repeat) {
    case 'minutes':
      return s.every === 1 ? 'Every minute' : `Every ${s.every} minutes`;
    case 'hours':
      return s.every === 1 ? 'Every hour, on the hour' : `Every ${s.every} hours, on the hour`;
    case 'day':
      return `Every day at ${s.at}`;
    case 'week':
      return `Every ${s.weekday} at ${s.at}`;
    case 'cron':
      return s.cron.trim() ? `On the cron rule ${s.cron.trim()}` : 'No cron rule yet';
    default:
      return 'Not set up';
  }
}

/**
 * The first minute strictly after `after` that the schedule fires, or the
 * reason it never can.
 */
export function nextFire(s: ScheduleSettings, after: Date): Date | { problem: string } {
  const rule = toCron(s);
  if ('problem' in rule) return rule;
  const parsed = parseCron(rule.cron);
  if ('problem' in parsed) return parsed;
  return nextMatch(parsed, after) ?? { problem: 'This rule never fires — no date matches it.' };
}

/* ------------------------------------------------------------------ cron */

interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

/**
 * Five fields: minute hour day-of-month month day-of-week. Each is `*`, a
 * number, a range `a-b`, a list `a,b`, or any of those with a step `/n`.
 * Day of week runs 0–6 from Sunday; 7 is Sunday too.
 */
export function parseCron(text: string): Cron | { problem: string } {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || !text.trim()) {
    return { problem: 'A cron rule has five fields: minute hour day month weekday, e.g. 0 9 * * 1-5.' };
  }
  const sets: Set<number>[] = [];
  for (const [i, part] of parts.entries()) {
    const field = FIELDS[i]!;
    const values = new Set<number>();
    for (const piece of part!.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
      if (!m) return { problem: `"${piece}" is not something the ${field.name} field understands.` };
      const [lo, hi] = m[1] === '*' ? [field.min, field.max] : rangeOf(m[1]!);
      const step = m[2] ? Number(m[2]) : 1;
      if (lo < field.min || hi > field.max || lo > hi || step < 1) {
        return { problem: `"${piece}" is outside the ${field.name} field's range, ${field.min} to ${field.max}.` };
      }
      for (let v = lo; v <= hi; v += step) values.add(i === 4 && v === 7 ? 0 : v);
    }
    sets.push(values);
  }
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow: sets[4]!,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function rangeOf(text: string): [number, number] {
  const [a, b] = text.split('-').map(Number);
  return [a!, b ?? a!];
}

/**
 * Walk forward from `after`, jumping a month, a day or an hour at a time
 * whenever that whole span cannot match, so a yearly rule is found in
 * hundreds of steps rather than half a million minutes.
 */
function nextMatch(c: Cron, after: Date): Date | undefined {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;

  while (t.getTime() <= limit) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    // Standard cron: when both day fields are restricted, either may match.
    const domHit = c.dom.has(t.getDate());
    const dowHit = c.dow.has(t.getDay());
    const dayHit = c.domAny && c.dowAny ? true : c.domAny ? dowHit : c.dowAny ? domHit : domHit || dowHit;
    if (!dayHit) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return undefined;
}
