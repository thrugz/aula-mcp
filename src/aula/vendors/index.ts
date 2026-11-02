/**
 * Vendor registry: which vendors the account's widgets enable, and a merged
 * fetch across all of them. A failing vendor becomes a warning; the others
 * still answer.
 */

import { easyiqLegacy, easyiqLektier, easyiqSkoleportal } from './easyiq.js';
import { huskelisten, meebook, muTasks, muWeeklyLetter } from './others.js';
import type { Vendor, VendorContext, VendorResult } from './types.js';

export const VENDORS: Vendor[] = [easyiqSkoleportal, easyiqLegacy, easyiqLektier, meebook, muWeeklyLetter, muTasks, huskelisten];

/** Known widgets this server does not read yet, so the user hears why nothing shows. */
export const UNSUPPORTED_WIDGETS: Record<string, string> = {
  '0003': 'Meebook bøger',
  '0014': 'EasyIQ Vigtig information',
  '0018': 'EasyIQ links',
  '0047': 'IST fravær',
  '0057': 'Docendo',
  '0072': 'MU elevfravær',
  '0108': 'Meddelelsesbog',
  '0119': 'Meebook notifikationer',
  '0145': 'IST fravær',
};

/** Enabled vendors with the widget id to use for each. */
export function enabledVendors(widgets: string[]): Array<{ vendor: Vendor; widgetId: string }> {
  const out: Array<{ vendor: Vendor; widgetId: string }> = [];
  for (const vendor of VENDORS) {
    const widgetId = vendor.widgetIds.find((w) => widgets.includes(w));
    if (widgetId) out.push({ vendor, widgetId });
  }
  return out;
}

export async function fetchAll(ctx: VendorContext, only?: string[]): Promise<VendorResult & { sources: string[] }> {
  const enabled = enabledVendors(ctx.family.widgets).filter(({ vendor }) => !only?.length || only.some((o) => vendor.id.startsWith(o)));
  const results = await Promise.allSettled(enabled.map(({ vendor, widgetId }) => vendor.fetch(ctx, widgetId)));
  const items = [];
  const warnings: string[] = [];
  for (const [i, r] of results.entries()) {
    const name = enabled[i]!.vendor.name;
    if (r.status === 'fulfilled') {
      items.push(...r.value.items);
      warnings.push(...r.value.warnings);
    } else {
      warnings.push(`${name}: ${(r.reason as Error).message}`);
    }
  }
  return { items, warnings, sources: enabled.map((e) => e.vendor.name) };
}

export { WidgetTokens } from './types.js';
export type { WeekItem, VendorContext } from './types.js';
