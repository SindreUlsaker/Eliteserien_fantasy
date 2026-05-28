import { describe, it, expect } from 'vitest';
import {
  normalizeChipName,
  chipNameForPoints,
  findBracketForRank,
  parseTop3Json,
  mergeTop3,
} from './computeEntryInsights';

describe('normalizeChipName', () => {
  it('mapper wildcard til wildcard1 før GW16', () => {
    expect(normalizeChipName('wildcard', 1)).toBe('wildcard1');
    expect(normalizeChipName('wildcard', 15)).toBe('wildcard1');
  });

  it('mapper wildcard til wildcard2 fra og med GW16', () => {
    expect(normalizeChipName('wildcard', 16)).toBe('wildcard2');
    expect(normalizeChipName('wildcard', 30)).toBe('wildcard2');
  });

  it('lar andre chips være uendret', () => {
    expect(normalizeChipName('2capt', 5)).toBe('2capt');
    expect(normalizeChipName('frush', 20)).toBe('frush');
    expect(normalizeChipName('pdbus', 10)).toBe('pdbus');
  });
});

describe('chipNameForPoints', () => {
  it('gjenkjenner alle 2capt-aliaser', () => {
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
    expect(chipNameForPoints('FrUsH')).toBe('frush');
  });

  it('returnerer null for ukjente chips', () => {
    expect(chipNameForPoints('wildcard')).toBeNull();
    expect(chipNameForPoints('rich')).toBeNull();
    expect(chipNameForPoints('')).toBeNull();
  });
});

describe('findBracketForRank', () => {
  const brackets = [
    { id: 1, name: '1-100', rankFrom: 1, rankTo: 100, active: true },
    { id: 2, name: '101-1000', rankFrom: 101, rankTo: 1000, active: true },
    { id: 3, name: '1001-10000', rankFrom: 1001, rankTo: 10000, active: true },
    { id: 4, name: 'inaktiv', rankFrom: 10001, rankTo: 50000, active: false },
  ];

  it('finner eksakt match innenfor et bracket', () => {
    expect(findBracketForRank(50, brackets)?.id).toBe(1);
    expect(findBracketForRank(500, brackets)?.id).toBe(2);
    expect(findBracketForRank(5000, brackets)?.id).toBe(3);
  });

  it('matcher grenseverdier inklusivt', () => {
    expect(findBracketForRank(1, brackets)?.id).toBe(1);
    expect(findBracketForRank(100, brackets)?.id).toBe(1);
    expect(findBracketForRank(101, brackets)?.id).toBe(2);
    expect(findBracketForRank(10000, brackets)?.id).toBe(3);
  });

  it('faller tilbake til høyeste aktive bracket for rank utenfor topp 10000', () => {
    expect(findBracketForRank(25000, brackets)?.id).toBe(3);
    expect(findBracketForRank(999999, brackets)?.id).toBe(3);
  });

  it('hopper over inaktive brackets ved fallback', () => {
    expect(findBracketForRank(20000, brackets)?.active).toBe(true);
    expect(findBracketForRank(20000, brackets)?.id).not.toBe(4);
  });

  it('returnerer null for null/undefined rank', () => {
    expect(findBracketForRank(null, brackets)).toBeNull();
    expect(findBracketForRank(undefined, brackets)).toBeNull();
  });

  it('returnerer null hvis ingen aktive brackets finnes', () => {
    expect(findBracketForRank(50, [])).toBeNull();
    expect(
      findBracketForRank(50, [{ id: 9, name: 'x', rankFrom: 1, rankTo: 100, active: false }])
    ).toBeNull();
  });
});

describe('parseTop3Json', () => {
  it('returnerer tomt array for ikke-array input', () => {
    expect(parseTop3Json(null)).toEqual([]);
    expect(parseTop3Json(undefined)).toEqual([]);
    expect(parseTop3Json({})).toEqual([]);
    expect(parseTop3Json('foo')).toEqual([]);
  });

  it('filtrerer bort items uten gyldige felt', () => {
    const input = [
      { gw: 1, playerId: 100, points: 12 },
      { gw: '2', playerId: 200, points: 8 }, // gw er string, droppes
      { gw: 3, playerId: 300 }, // mangler points
      { gw: 4, playerId: 400, points: 5 },
    ];
    expect(parseTop3Json(input)).toEqual([
      { gw: 1, playerId: 100, points: 12 },
      { gw: 4, playerId: 400, points: 5 },
    ]);
  });

  it('beholder rekkefølgen fra input', () => {
    const input = [
      { gw: 5, playerId: 1, points: 3 },
      { gw: 1, playerId: 2, points: 20 },
    ];
    expect(parseTop3Json(input)).toEqual(input);
  });
});

describe('mergeTop3', () => {
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
    expect(mergeTop3([], [{ gw: 1, playerId: 1, points: 5 }])).toEqual([
      { gw: 1, playerId: 1, points: 5 },
    ]);
  });

  it('returnerer alltid maks 3 elementer', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      gw: i + 1,
      playerId: i + 1,
      points: i + 1,
    }));
    expect(mergeTop3(many, [])).toHaveLength(3);
  });
});
