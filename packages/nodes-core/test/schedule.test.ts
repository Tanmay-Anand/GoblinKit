import { describe, expect, it } from 'vitest';

import { describeSchedule, nextFire, parseCron, scheduleSettings, type ScheduleSettings } from '@goblin/nodes-core';

/** Local time, like the schedule itself: 2026-09-25 is a Friday. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const s = (over: Partial<ScheduleSettings>): ScheduleSettings => ({ ...scheduleSettings({}), ...over });
const next = (settings: ScheduleSettings, from: Date) => {
  const r = nextFire(settings, from);
  if (!(r instanceof Date)) throw new Error(r.problem);
  return r;
};

describe('when a schedule fires next', () => {
  it('every 15 minutes lands on the quarter hours', () => {
    expect(next(s({ repeat: 'minutes', every: 15 }), at(2026, 9, 25, 10, 7))).toEqual(at(2026, 9, 25, 10, 15));
    // Strictly after: firing at 10:15 schedules 10:30, never 10:15 again.
    expect(next(s({ repeat: 'minutes', every: 15 }), at(2026, 9, 25, 10, 15))).toEqual(at(2026, 9, 25, 10, 30));
  });

  it('every 6 hours fires on the hour at 0, 6, 12 and 18', () => {
    expect(next(s({ repeat: 'hours', every: 6 }), at(2026, 9, 25, 13, 40))).toEqual(at(2026, 9, 25, 18, 0));
  });

  it('every day at a time rolls over to tomorrow once that time has passed', () => {
    expect(next(s({ repeat: 'day', at: '09:30' }), at(2026, 9, 25, 8, 0))).toEqual(at(2026, 9, 25, 9, 30));
    expect(next(s({ repeat: 'day', at: '09:30' }), at(2026, 9, 25, 9, 30))).toEqual(at(2026, 9, 26, 9, 30));
  });

  it('every week on a day finds the next one of that day', () => {
    // From Friday the 25th, the next Monday is the 28th.
    expect(next(s({ repeat: 'week', weekday: 'Monday', at: '08:00' }), at(2026, 9, 25, 12))).toEqual(at(2026, 9, 28, 8, 0));
  });

  it('a cron rule for weekdays at nine skips the weekend', () => {
    expect(next(s({ repeat: 'cron', cron: '0 9 * * 1-5' }), at(2026, 9, 25, 10))).toEqual(at(2026, 9, 28, 9, 0));
  });

  it('a yearly rule is found without walking every minute of the year', () => {
    expect(next(s({ repeat: 'cron', cron: '0 0 1 1 *' }), at(2026, 9, 25))).toEqual(at(2027, 1, 1, 0, 0));
  });

  it('when both day fields are set, either one matching is enough — as in standard cron', () => {
    // The 1st of the month OR any Sunday; from Fri the 25th, Sunday the 27th comes first.
    expect(next(s({ repeat: 'cron', cron: '0 12 1 * 0' }), at(2026, 9, 25))).toEqual(at(2026, 9, 27, 12, 0));
  });
});

describe('schedules that cannot work say why', () => {
  it.each([
    [s({ repeat: 'minutes', every: 0 }), /1 to 59/],
    [s({ repeat: 'day', at: '25:00' }), /not a time/],
    [s({ repeat: 'cron', cron: '0 9 * *' }), /five fields/],
    [s({ repeat: 'cron', cron: '61 * * * *' }), /outside the minute field's range/],
    [s({ repeat: 'cron', cron: '0 0 31 2 *' }), /never fires/],
  ])('%j', (settings, message) => {
    const r = nextFire(settings, at(2026, 9, 25));
    expect(r instanceof Date ? 'fires' : r.problem).toMatch(message);
  });

  it('accepts 7 as Sunday', () => {
    expect(parseCron('0 0 * * 7')).toMatchObject({ dow: new Set([0]) });
  });
});

describe('what the canvas says about a schedule', () => {
  it('reads as a sentence', () => {
    expect(describeSchedule(s({ repeat: 'minutes', every: 1 }))).toBe('Every minute');
    expect(describeSchedule(s({ repeat: 'week', weekday: 'Friday', at: '17:00' }))).toBe('Every Friday at 17:00');
  });
});
