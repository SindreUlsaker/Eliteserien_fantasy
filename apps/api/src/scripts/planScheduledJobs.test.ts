import { describe, it, expect } from 'vitest';
import {
  parseIsoOrThrow,
  addMinutes,
  nextDayAtUtc,
  parseEvents,
  parseFixtures,
  getLastKickoffByEvent,
} from './planScheduledJobs';

describe('parseIsoOrThrow', () => {
  it('parser gyldig ISO-string', () => {
    const d = parseIsoOrThrow('2026-05-29T16:55:00Z', 'test');
    expect(d.toISOString()).toBe('2026-05-29T16:55:00.000Z');
  });

  it('kaster med feltnavn i feilmeldingen for ugyldig input', () => {
    expect(() => parseIsoOrThrow('ikke-en-dato', 'deadline')).toThrow(/deadline/);
    expect(() => parseIsoOrThrow('ikke-en-dato', 'deadline')).toThrow(/ikke-en-dato/);
  });
});

describe('addMinutes', () => {
  it('legger til positive minutter', () => {
    const base = new Date('2026-05-29T16:55:00Z');
    expect(addMinutes(base, 5).toISOString()).toBe('2026-05-29T17:00:00.000Z');
  });

  it('legger til negative minutter', () => {
    const base = new Date('2026-05-29T16:55:00Z');
    expect(addMinutes(base, -10).toISOString()).toBe('2026-05-29T16:45:00.000Z');
  });

  it('krysser dato-grense', () => {
    const base = new Date('2026-05-29T23:55:00Z');
    expect(addMinutes(base, 10).toISOString()).toBe('2026-05-30T00:05:00.000Z');
  });
});

describe('nextDayAtUtc', () => {
  it('returnerer neste dag på oppgitt UTC-time', () => {
    const base = new Date('2026-05-29T22:15:00Z');
    expect(nextDayAtUtc(base, 8, 0).toISOString()).toBe('2026-05-30T08:00:00.000Z');
  });

  it('krysser månedsslutt', () => {
    const base = new Date('2026-05-31T23:00:00Z');
    expect(nextDayAtUtc(base, 8, 0).toISOString()).toBe('2026-06-01T08:00:00.000Z');
  });

  it('krysser årsslutt', () => {
    const base = new Date('2026-12-31T18:00:00Z');
    expect(nextDayAtUtc(base, 8, 30).toISOString()).toBe('2027-01-01T08:30:00.000Z');
  });

  it('ignorerer lokal tidssone — bruker UTC-komponenter av base', () => {
    // 02:00 UTC = aller første timer av 30. mai uavhengig av lokal tz
    const base = new Date('2026-05-30T02:00:00Z');
    expect(nextDayAtUtc(base, 8, 0).toISOString()).toBe('2026-05-31T08:00:00.000Z');
  });
});

describe('parseEvents', () => {
  it('parser gyldige events', () => {
    const data = {
      events: [
        { id: 1, deadline_time: '2026-03-14T15:10:00Z', finished: true },
        { id: 2, deadline_time: '2026-03-21T14:55:00Z', finished: false },
      ],
    };
    expect(parseEvents(data)).toEqual([
      { id: 1, deadline_time: '2026-03-14T15:10:00Z', finished: true },
      { id: 2, deadline_time: '2026-03-21T14:55:00Z', finished: false },
    ]);
  });

  it('hopper over rader med feil typer på pålagte felter', () => {
    const data = {
      events: [
        { id: 1, deadline_time: '2026-03-14T15:10:00Z', finished: true },
        { id: '2', deadline_time: '2026-03-21T14:55:00Z', finished: false }, // id må være number
        { id: 3, deadline_time: 123, finished: false }, // deadline_time må være string
        { id: 4, deadline_time: '2026-04-06T12:25:00Z', finished: 'true' }, // finished må være boolean
        null,
        'not-an-object',
      ],
    };
    expect(parseEvents(data).map((e) => e.id)).toEqual([1]);
  });

  it('kaster hvis events-feltet ikke er en array', () => {
    expect(() => parseEvents({})).toThrow(/missing events array/);
    expect(() => parseEvents({ events: null })).toThrow(/missing events array/);
    expect(() => parseEvents({ events: 'foo' })).toThrow(/missing events array/);
  });

  it('kaster hvis alle eventer ble filtrert vekk', () => {
    expect(() => parseEvents({ events: [null, 'foo', { id: '1' }] })).toThrow(/No valid events/);
  });

  it('inkluderer både ferdige og ikke-ferdige events (filtrering skjer senere)', () => {
    const data = {
      events: [
        { id: 1, deadline_time: '2026-03-14T15:10:00Z', finished: true },
        { id: 2, deadline_time: '2026-03-21T14:55:00Z', finished: false },
      ],
    };
    expect(parseEvents(data)).toHaveLength(2);
  });
});

describe('parseFixtures', () => {
  it('parser fixtures med event og kickoff_time', () => {
    const data = [
      { event: 11, kickoff_time: '2026-05-29T17:00:00Z' },
      { event: 11, kickoff_time: '2026-05-30T14:00:00Z' },
    ];
    expect(parseFixtures(data)).toEqual([
      { event: 11, kickoff_time: '2026-05-29T17:00:00Z' },
      { event: 11, kickoff_time: '2026-05-30T14:00:00Z' },
    ]);
  });

  it('setter event til null hvis ikke number', () => {
    const data = [{ event: '11', kickoff_time: '2026-05-29T17:00:00Z' }];
    expect(parseFixtures(data)[0].event).toBeNull();
  });

  it('setter kickoff_time til null hvis ikke string', () => {
    const data = [{ event: 11, kickoff_time: null }];
    expect(parseFixtures(data)[0].kickoff_time).toBeNull();
  });

  it('hopper over rader som ikke er objekter', () => {
    const data = [null, 'foo', 42, { event: 1, kickoff_time: '2026-05-29T17:00:00Z' }];
    expect(parseFixtures(data)).toHaveLength(1);
  });

  it('kaster hvis input ikke er en array', () => {
    expect(() => parseFixtures({})).toThrow(/did not return an array/);
    expect(() => parseFixtures(null)).toThrow(/did not return an array/);
  });
});

describe('getLastKickoffByEvent', () => {
  it('returnerer den seneste kickoffen per event', () => {
    const fixtures = [
      { event: 11, kickoff_time: '2026-05-29T17:00:00Z' },
      { event: 11, kickoff_time: '2026-05-30T14:00:00Z' }, // sist
      { event: 11, kickoff_time: '2026-05-30T12:00:00Z' },
      { event: 12, kickoff_time: '2026-07-11T12:00:00Z' },
      { event: 12, kickoff_time: '2026-07-12T17:15:00Z' }, // sist
    ];
    const result = getLastKickoffByEvent(fixtures);
    expect(result.get(11)?.toISOString()).toBe('2026-05-30T14:00:00.000Z');
    expect(result.get(12)?.toISOString()).toBe('2026-07-12T17:15:00.000Z');
  });

  it('ignorerer fixtures med null event', () => {
    const fixtures = [
      { event: null, kickoff_time: '2026-05-29T17:00:00Z' },
      { event: 11, kickoff_time: '2026-05-30T14:00:00Z' },
    ];
    const result = getLastKickoffByEvent(fixtures);
    expect(result.size).toBe(1);
    expect(result.get(11)?.toISOString()).toBe('2026-05-30T14:00:00.000Z');
  });

  it('ignorerer fixtures med null kickoff_time', () => {
    const fixtures = [
      { event: 11, kickoff_time: null },
      { event: 12, kickoff_time: '2026-07-11T12:00:00Z' },
    ];
    const result = getLastKickoffByEvent(fixtures);
    expect(result.size).toBe(1);
    expect(result.has(11)).toBe(false);
    expect(result.get(12)?.toISOString()).toBe('2026-07-11T12:00:00.000Z');
  });

  it('returnerer tomt map for tom input', () => {
    expect(getLastKickoffByEvent([]).size).toBe(0);
  });

  it('takler en enkelt kickoff per event', () => {
    const fixtures = [{ event: 22, kickoff_time: '2026-10-11T15:00:00Z' }];
    expect(getLastKickoffByEvent(fixtures).get(22)?.toISOString()).toBe('2026-10-11T15:00:00.000Z');
  });

  it('kaster hvis kickoff_time er en ugyldig ISO-streng', () => {
    const fixtures = [{ event: 1, kickoff_time: 'tull' }];
    expect(() => getLastKickoffByEvent(fixtures)).toThrow(/event=1/);
  });
});
