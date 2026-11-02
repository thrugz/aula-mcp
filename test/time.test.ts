import { describe, expect, it } from 'vitest';
import { clip, htmlToText, withinBudget } from '../src/aula/text.js';
import {
  addDays,
  aulaTimestamp,
  chunkRange,
  cphDate,
  cphMidnight,
  isoWeek,
  isoWeekMonday,
  localDateTime,
  parseInstant,
  resolveRange,
} from '../src/aula/time.js';

describe('Copenhagen time', () => {
  it('converts Aula UTC timestamps to local time (summer and winter)', () => {
    expect(localDateTime('2026-10-12T06:00:00+00:00')).toBe('2026-10-12 08:00');
    expect(localDateTime('2026-11-02T07:00:00+00:00')).toBe('2026-11-02 08:00');
    expect(localDateTime('2026-10-12 06:00:00.0000+0000')).toBe('2026-10-12 08:00');
  });

  it('treats timestamps without an offset as local wall time', () => {
    expect(localDateTime('2026/10/05 08:00')).toBe('2026-10-05 08:00');
    expect(parseInstant('2026-10-05 08:00')?.toISOString()).toBe('2026-10-05T06:00:00.000Z');
  });

  it('reads Danish day-first dates and refuses unknown formats', () => {
    expect(localDateTime('5-10-2026 08:00')).toBe('2026-10-05 08:00');
    expect(localDateTime('05.10.2026')).toBe('2026-10-05 00:00');
    expect(parseInstant('next tuesday')).toBeUndefined();
  });

  it('finds local midnight across DST changes', () => {
    expect(cphMidnight('2026-03-29').toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(cphMidnight('2026-03-30').toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(cphMidnight('2026-10-25').toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(cphMidnight('2026-10-26').toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('formats Aula calendar request timestamps with the local offset', () => {
    expect(aulaTimestamp(cphMidnight('2026-10-12'))).toBe('2026-10-12 00:00:00.0000+0200');
    expect(aulaTimestamp(cphMidnight('2026-12-01'))).toBe('2026-12-01 00:00:00.0000+0100');
  });

  it('uses the local date near midnight UTC', () => {
    expect(cphDate(new Date('2026-10-11T22:30:00Z'))).toBe('2026-10-12');
  });
});

describe('ISO weeks', () => {
  it('uses the ISO week-numbering year at year boundaries', () => {
    expect(isoWeek('2026-10-09')).toBe('2026-W41');
    expect(isoWeek('2026-12-31')).toBe('2026-W53');
    expect(isoWeek('2027-01-03')).toBe('2026-W53');
    expect(isoWeek('2027-01-04')).toBe('2027-W01');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
  });

  it('maps a week label back to its Monday', () => {
    expect(isoWeekMonday('2026-W41')).toBe('2026-10-05');
    expect(isoWeekMonday('2025-W01')).toBe('2024-12-30');
  });
});

describe('ranges', () => {
  const today = '2026-10-09'; // Friday
  it('resolves named ranges', () => {
    expect(resolveRange({ range: 'this_week' }, today)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(resolveRange({ range: 'next_week' }, today)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(resolveRange({ range: 'tomorrow' }, today)).toEqual({ from: '2026-10-10', to: '2026-10-10' });
  });

  it('accepts a single explicit date as a one-day range and rejects reversed ranges', () => {
    expect(resolveRange({ from: '2026-10-20' }, today)).toEqual({ from: '2026-10-20', to: '2026-10-20' });
    expect(() => resolveRange({ from: '2026-10-20', to: '2026-10-19' }, today)).toThrow();
  });

  it('chunks long ranges for the 50-day calendar limit', () => {
    const chunks = chunkRange({ from: '2026-01-01', to: addDays('2026-01-01', 119) }, 50);
    expect(chunks.map((c) => [c.from, c.to])).toEqual([
      ['2026-01-01', '2026-02-19'],
      ['2026-02-20', '2026-04-10'],
      ['2026-04-11', '2026-04-30'],
    ]);
  });
});

describe('text', () => {
  it('turns HTML into readable text', () => {
    expect(htmlToText('<p>Hej <b>alle</b></p><ul><li>Madpakke</li><li>Gymnastiktøj</li></ul><p>Mvh&nbsp;Lise</p>')).toBe(
      'Hej alle\n- Madpakke\n- Gymnastiktøj\n\nMvh Lise',
    );
    expect(htmlToText('Line<br>break &amp; more')).toBe('Line\nbreak & more');
  });

  it('clips on a word boundary', () => {
    expect(clip('one two three four', 10)).toBe('one two [...]');
  });

  it('reports what the budget left out', () => {
    expect(withinBudget(['aaaa', 'bbbb', 'cccc'], 9, 'events')).toBe(
      'aaaa\nbbbb\n[1 more events not shown: output limit reached. Narrow the date range or filter by child.]',
    );
  });
});
