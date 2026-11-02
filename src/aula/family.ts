/**
 * The family as Aula sees it: the guardian, the children, their institutions,
 * and the vendor widgets enabled for the account. Tools address children by
 * name; this module turns a name into every id the various endpoints want.
 *
 * Id vocabulary (mixing them up returns empty data, not errors):
 *   child.id        institution profile id: presence, calendar, templates
 *   child.userId    unilogin id: Meebook, Min Uddannelse, EasyIQ SkolePortal
 *   guardianUserId  from the profile context: vendor session ids
 */

import { InputError } from '../errors.js';
import type { AulaClient } from './client.js';

export interface Child {
  /** Institution profile id. */
  id: number;
  name: string;
  firstName: string;
  /** Unilogin id, e.g. "nora4047". */
  userId?: string;
  institutionCode?: string;
  institutionName?: string;
  className?: string;
}

export interface Family {
  guardianName: string;
  guardianUserId?: string;
  /** The guardian's own institution profile ids (posts are addressed to these too). */
  guardianProfileIds: number[];
  institutionCodes: string[];
  children: Child[];
  /** Enabled vendor widget ids, e.g. "0029". */
  widgets: string[];
}

interface RawChild {
  id?: number;
  name?: string;
  userId?: string | number;
  institutionProfile?: { id?: number; institutionName?: string; institutionCode?: string; metadata?: string };
}

interface RawProfile {
  displayName?: string;
  name?: string;
  children?: RawChild[];
  institutionProfiles?: Array<{ id?: number; institutionCode?: string; fullName?: string }>;
}

interface RawContext {
  userId?: string | number;
  pageConfiguration?: { widgetConfigurations?: Array<{ widget?: { widgetId?: string | number }; widgetId?: string | number }> };
}

export function parseFamily(profiles: { profiles?: RawProfile[] }, context: RawContext): Family {
  const children = new Map<number, Child>();
  const guardianProfileIds = new Set<number>();
  const codes = new Set<string>();
  let guardianName = '';
  for (const p of profiles.profiles ?? []) {
    guardianName ||= p.displayName ?? p.name ?? p.institutionProfiles?.[0]?.fullName ?? '';
    for (const ip of p.institutionProfiles ?? []) {
      if (typeof ip.id === 'number') guardianProfileIds.add(ip.id);
      if (ip.institutionCode) codes.add(ip.institutionCode);
    }
    for (const c of p.children ?? []) {
      if (typeof c.id !== 'number' || children.has(c.id)) continue;
      const name = (c.name ?? '').trim();
      const ip = c.institutionProfile ?? {};
      if (ip.institutionCode) codes.add(ip.institutionCode);
      children.set(c.id, {
        id: c.id,
        name,
        firstName: name.split(/\s+/)[0] ?? name,
        ...(c.userId !== undefined && c.userId !== null && c.userId !== '' ? { userId: String(c.userId) } : {}),
        ...(ip.institutionCode ? { institutionCode: ip.institutionCode } : {}),
        ...(ip.institutionName ? { institutionName: ip.institutionName } : {}),
        ...(ip.metadata ? { className: ip.metadata } : {}),
      });
    }
  }
  const widgets = new Set<string>();
  for (const w of context.pageConfiguration?.widgetConfigurations ?? []) {
    const id = w.widget?.widgetId ?? w.widgetId;
    if (id === undefined || id === null) continue;
    // Normalise "142", 142 and "00142" (seen in scaarup) to "0142".
    const raw = String(id).trim();
    widgets.add(/^\d+$/.test(raw) ? String(Number(raw)).padStart(4, '0') : raw);
  }
  return {
    guardianName,
    ...(context.userId !== undefined && context.userId !== null ? { guardianUserId: String(context.userId) } : {}),
    guardianProfileIds: [...guardianProfileIds],
    institutionCodes: [...codes],
    children: [...children.values()],
    widgets: [...widgets].sort(),
  };
}

/** Loads and caches the family for ten minutes. */
export class FamilyCache {
  private value?: { until: number; family: Promise<Family> };
  private readonly client: AulaClient;

  constructor(client: AulaClient) {
    this.client = client;
  }

  get(): Promise<Family> {
    if (this.value && this.value.until > Date.now()) return this.value.family;
    const family = Promise.all([
      this.client.get<{ profiles?: RawProfile[] }>('profiles.getProfilesByLogin'),
      this.client.profileContext<RawContext>(),
    ]).then(([profiles, context]) => parseFamily(profiles, context));
    this.value = { until: Date.now() + 10 * 60_000, family };
    family.catch(() => {
      this.value = undefined;
    });
    return family;
  }
}

/** Fold case and Danish letters so "orn", "Ørn" and "Oern" all compare equal. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/aa/g, 'a')
    .replace(/oe/g, 'o')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Children matching `query` (a name, a first name, a prefix, or a numeric id).
 * Empty or "all" means every child. Throws with the candidates when the name
 * is unknown or ambiguous, so the model can ask instead of guessing.
 */
export function pickChildren(family: Family, query?: string): Child[] {
  if (family.children.length === 0) throw new InputError('This Aula account has no children attached.');
  const q = query?.trim();
  if (!q || /^(all|alle|everyone|begge|both)$/i.test(q)) return family.children;
  if (/^\d+$/.test(q)) {
    const byId = family.children.find((c) => c.id === Number(q));
    if (byId) return [byId];
  }
  const fq = fold(q);
  const tiers: Array<(c: Child) => boolean> = [
    (c) => fold(c.name) === fq,
    (c) => fold(c.firstName) === fq,
    (c) => fold(c.name).split(' ').includes(fq),
    (c) => fold(c.name).startsWith(fq) || fold(c.name).split(' ').some((t) => t.startsWith(fq)),
  ];
  for (const test of tiers) {
    const hits = family.children.filter(test);
    if (hits.length === 1) return hits;
    if (hits.length > 1) {
      throw new InputError(`"${q}" matches several children: ${hits.map((c) => c.name).join(', ')}. Use the full name.`);
    }
  }
  throw new InputError(`No child called "${q}". Children on this account: ${family.children.map((c) => c.name).join(', ')}.`);
}

/** Short label: first name, or full name when siblings share a first name. */
export function childLabel(family: Family, child: Child): string {
  const clash = family.children.filter((c) => fold(c.firstName) === fold(child.firstName)).length > 1;
  return clash ? child.name : child.firstName;
}
