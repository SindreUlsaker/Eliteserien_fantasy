import { describe, it, expect } from 'vitest';
import {
  normalizeChipName,
  chipNameForPoints,
  parseTop3Json,
  mergeTop3,
  elementTypeKey,
} from './computeEntrySeasonTotals';

// Disse helperne er duplikater av nesten-samme logikk i
// services/computeEntryInsights.ts. Tester her bevisst skript-versjonen for å
// dokumentere oppførselen — særlig at normalizeChipName her lowercaser input
// før sammenligning (det gjør ikke service-versjonen).

describe('normalizeChipName (script)', () => {
  it('mapper wildcard til wildcard1 t.o.m. GW15', () => {
    expect(normalizeChipName('wildcard', 1)).toBe('wildcard1');
    expect(normalizeChipName('wildcard', 15)).toBe('wildcard1');
  });

  it('mapper wildcard til wildcard2 fra og med GW16', () => {
    expect(normalizeChipName('wildcard', 16)).toBe('wildcard2');
    expect(normalizeChipName('wildcard', 30)).toBe('wildcard2');
  });

  it('er case-insensitiv på chip-navnet (skiller fra service-versjonen)', () => {
    expect(normalizeChipName('Wildcard', 5)).toBe('wildcard1');
    expect(normalizeChipName('WILDCARD', 20)).toBe('wildcard2');
  });

  it('lowercaser andre chips og lar dem ellers stå', () => {
    expect(normalizeChipName('2capt', 5)).toBe('2capt');
    expect(normalizeChipName('FRUSH', 5)).toBe('frush');
    expect(normalizeChipName('Pdbus', 10)).toBe('pdbus');
    expect(normalizeChipName('rich', 20)).toBe('rich');
  });
});

describe('chipNameForPoints (script)', () => {
  it('gjenkjenner 2capt-aliaser', () => {
    expect(chipNameForPoints('2capt')).toBe('2capt');
    expect(chipNameForPoints('3xc')).toBe('2capt');
    expect(chipNameForPoints('triple_captain')).toBe('2capt');
    expect(chipNameForPoints('triple captain')).toBe('2capt');
    expect(chipNameForPoints('Dobbelt kaptein')).toBe('2capt');
  });

  it('gjenkjenner frush-aliaser', () => {
    expect(chipNameForPoints('frush')).toBe('frush');
    expect(chipNameForPoints('freehit')).toBe('frush');
    expect(chipNameForPoints('spissrush')).toBe('frush');
  });

  it('gjenkjenner pdbus-aliaser', () => {
    expect(chipNameForPoints('pdbus')).toBe('pdbus');
    expect(chipNameForPoints('parker bussen')).toBe('pdbus');
    expect(chipNameForPoints('parker_bussen')).toBe('pdbus');
  });

  it('er case-insensitiv', () => {
    expect(chipNameForPoints('2CAPT')).toBe('2capt');
    expect(chipNameForPoints('FREEHIT')).toBe('frush');
    expect(chipNameForPoints('PARKER BUSSEN')).toBe('pdbus');
  });

  it('returnerer null for wildcard og rich (de gir ikke poeng-beregning)', () => {
    expect(chipNameForPoints('wildcard1')).toBeNull();
    expect(chipNameForPoints('wildcard2')).toBeNull();
    expect(chipNameForPoints('rich')).toBeNull();
  });

  it('returnerer null for ukjente navn', () => {
    expect(chipNameForPoints('tull')).toBeNull();
    expect(chipNameForPoints('')).toBeNull();
  });
});

describe('parseTop3Json (script)', () => {
  it('returnerer tomt array for ikke-array input', () => {
    expect(parseTop3Json(null)).toEqual([]);
    expect(parseTop3Json(undefined)).toEqual([]);
    expect(parseTop3Json({})).toEqual([]);
    expect(parseTop3Json('foo')).toEqual([]);
  });

  it('filtrerer bort items uten gyldige felt', () => {
    const input = [
      { gw: 1, playerId: 100, points: 12 },
      { gw: '2', playerId: 200, points: 8 }, // gw er string -> dropp
      { gw: 3, playerId: 300 }, // mangler points
      { gw: 4, playerId: 400, points: 5 },
    ];
    expect(parseTop3Json(input)).toEqual([
      { gw: 1, playerId: 100, points: 12 },
      { gw: 4, playerId: 400, points: 5 },
    ]);
  });
});

describe('mergeTop3 (script)', () => {
  it('sorterer descending på points og kapper til 3', () => {
    const existing = [
      { gw: 1, playerId: 100, points: 10 },
      { gw: 2, playerId: 200, points: 5 },
    ];
    const add = [
      { gw: 3, playerId: 300, points: 15 },
      { gw: 4, playerId: 400, points: 8 },
    ];
    expect(mergeTop3(existing, add)).toEqual([
      { gw: 3, playerId: 300, points: 15 },
      { gw: 1, playerId: 100, points: 10 },
      { gw: 4, playerId: 400, points: 8 },
    ]);
  });

  it('tie-breaker: lavest gw vinner ved likt antall poeng', () => {
    const result = mergeTop3(
      [
        { gw: 5, playerId: 1, points: 10 },
        { gw: 2, playerId: 2, points: 10 },
      ],
      [{ gw: 8, playerId: 3, points: 10 }]
    );
    expect(result.map((x) => x.gw)).toEqual([2, 5, 8]);
  });

  it('takler tomme arrays', () => {
    expect(mergeTop3([], [])).toEqual([]);
    expect(mergeTop3([{ gw: 1, playerId: 1, points: 5 }], [])).toEqual([
      { gw: 1, playerId: 1, points: 5 },
    ]);
  });
});

describe('elementTypeKey', () => {
  it('mapper kjente element-typer', () => {
    expect(elementTypeKey(1)).toBe('gkp');
    expect(elementTypeKey(2)).toBe('def');
    expect(elementTypeKey(3)).toBe('mid');
    expect(elementTypeKey(4)).toBe('fwd');
  });

  it('returnerer "unk" for ukjente verdier', () => {
    expect(elementTypeKey(0)).toBe('unk');
    expect(elementTypeKey(5)).toBe('unk');
    expect(elementTypeKey(-1)).toBe('unk');
  });
});
