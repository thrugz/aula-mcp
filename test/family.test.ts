import { describe, expect, it } from 'vitest';
import { childLabel, fold, parseFamily, pickChildren } from '../src/aula/family.js';

const family = parseFamily(
  {
    profiles: [
      {
        displayName: 'Forælder Eksempel',
        institutionProfiles: [{ id: 900, institutionCode: 'G1234' }],
        children: [
          { id: 101, name: 'Ørn Prøve Eksempel', userId: 'barn1234', institutionProfile: { institutionName: 'Skolen', institutionCode: 'G1234', metadata: '2A' } },
          { id: 102, name: 'Måge Eksempel', userId: 'barn5678', institutionProfile: { institutionName: 'Børnehuset', institutionCode: 'D5678' } },
          { id: 103, name: 'Måge Anden Prøve', institutionProfile: { institutionCode: 'G1234' } },
        ],
      },
    ],
  },
  { userId: 4242, pageConfiguration: { widgetConfigurations: [{ widget: { widgetId: '0029' } }, { widgetId: 30 }] } },
);

describe('parseFamily', () => {
  it('collects children, ids, institutions and widgets', () => {
    expect(family.guardianName).toBe('Forælder Eksempel');
    expect(family.guardianUserId).toBe('4242');
    expect(family.guardianProfileIds).toEqual([900]);
    expect(family.institutionCodes.sort()).toEqual(['D5678', 'G1234']);
    expect(family.widgets).toEqual(['0029', '0030']);
    expect(family.children[0]).toMatchObject({ id: 101, firstName: 'Ørn', userId: 'barn1234', className: '2A' });
  });
});

describe('pickChildren', () => {
  it('matches names regardless of case and Danish letters', () => {
    expect(fold('Ørn Å Æble')).toBe('orn a aeble');
    expect(pickChildren(family, 'orn').map((c) => c.id)).toEqual([101]);
    expect(pickChildren(family, 'Oern').map((c) => c.id)).toEqual([101]);
    expect(pickChildren(family, 'ør').map((c) => c.id)).toEqual([101]);
  });

  it('returns every child for empty or "all"', () => {
    expect(pickChildren(family)).toHaveLength(3);
    expect(pickChildren(family, 'alle')).toHaveLength(3);
  });

  it('prefers an exact full name over a shared first name', () => {
    expect(pickChildren(family, 'Måge Eksempel').map((c) => c.id)).toEqual([102]);
  });

  it('refuses to guess between siblings with the same first name', () => {
    expect(() => pickChildren(family, 'Måge')).toThrow(/several children: Måge Eksempel, Måge Anden Prøve/);
  });

  it('names the children when nothing matches', () => {
    expect(() => pickChildren(family, 'Ugle')).toThrow(/Ørn Prøve Eksempel/);
  });

  it('accepts an institution profile id', () => {
    expect(pickChildren(family, '102').map((c) => c.name)).toEqual(['Måge Eksempel']);
  });

  it('labels with first names unless they clash', () => {
    expect(childLabel(family, family.children[0]!)).toBe('Ørn');
    expect(childLabel(family, family.children[1]!)).toBe('Måge Eksempel');
  });
});
