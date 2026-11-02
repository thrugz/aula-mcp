/**
 * Parsers for the HTML pages in the login chain: the broker's IdP form, the
 * NemLog-in page, the SAML auto-submit forms, the identity picker and the
 * Keycloak confirmation page. Pure functions, tested against fixtures.
 */

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Hidden and text inputs of one form (the first by default). */
export function formInputs($: CheerioAPI, form: Cheerio<AnyNode> = $('form').first()): Record<string, string> {
  const out: Record<string, string> = {};
  form.find('input').each((_, el) => {
    const name = $(el).attr('name');
    const type = ($(el).attr('type') ?? 'hidden').toLowerCase();
    if (!name || (type !== 'hidden' && type !== 'text')) return;
    out[name] = $(el).attr('value') ?? '';
  });
  return out;
}

export function load(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** First form's action and inputs. */
export function firstForm(html: string): { action: string | null; inputs: Record<string, string> } {
  const $ = load(html);
  const form = $('form').first();
  return { action: form.attr('action') ?? null, inputs: formInputs($, form) };
}

/**
 * First form's action with the inputs of every form on the page merged, which
 * is what the proven login flow posts on broker pages. Also reports whether a
 * `selected-aktoer` field exists in any input type (radio included), so the
 * guardian role can be chosen even when it is not a hidden field.
 */
export function brokerForm(html: string): { action: string | null; inputs: Record<string, string>; hasRoleField: boolean } {
  const $ = load(html);
  return {
    action: $('form').first().attr('action') ?? null,
    inputs: formInputs($, $('form')),
    hasRoleField: $('[name="selected-aktoer"]').length > 0,
  };
}

/**
 * The ASP.NET anti-forgery token on the NemLog-in MitID page, read the way the
 * proven flow reads it: inputs of all forms merged, a later one winning.
 */
export function verificationToken(html: string): string | null {
  const $ = load(html);
  return formInputs($, $('form')).__RequestVerificationToken ?? null;
}

export interface SamlForm {
  action: string;
  samlResponse: string;
  /** Missing on some level-3 flows (scaarup #310); sent empty then. */
  relayState: string;
}

/** The form carrying a SAMLResponse, wherever it sits on the page. */
export function samlForm(html: string): SamlForm | null {
  const $ = load(html);
  const input = $('input[name="SAMLResponse"]').first();
  if (input.length === 0) return null;
  const form = input.closest('form');
  return {
    action: form.attr('action') ?? '',
    samlResponse: input.attr('value') ?? '',
    relayState: form.find('input[name="RelayState"]').first().attr('value') ?? '',
  };
}

export function metaRefreshUrl(html: string): string | null {
  const $ = load(html);
  const content = $('meta').filter((_, el) => ($(el).attr('http-equiv') ?? '').toLowerCase() === 'refresh').first().attr('content');
  return content ? (/url\s*=\s*['"]?([^'"]+)['"]?/i.exec(content)?.[1] ?? null) : null;
}

export interface IdentityOption {
  /** 1-based, as shown to the user. */
  index: number;
  label: string;
  /** `data-loginoptions` verbatim; posted back as ChosenOptionJson. */
  loginOptionsJson: string;
}

/** NemLog-in `/loginoption`: shown when one MitID has several identities. */
export function identityOptions(html: string): { options: IdentityOption[]; inputs: Record<string, string> } {
  const $ = load(html);
  const options: IdentityOption[] = [];
  $('a[data-loginoptions]').each((_, el) => {
    const a = $(el);
    const labelEl = a.find('.list-link-text').first().length
      ? a.find('.list-link-text').first()
      : a.closest('.list-link-box').find('.list-link-text').first();
    const label = (labelEl.text() || a.text()).replace(/\s+/g, ' ').trim();
    options.push({ index: options.length + 1, label: label || `Identity ${options.length + 1}`, loginOptionsJson: a.attr('data-loginoptions') ?? '' });
  });
  // Inputs of all forms, as upstream posts them (a language form may come first).
  return { options, inputs: formInputs($, $('form')) };
}

/** Keycloak's "confirm and continue" page after broker login (scaarup #306/#287). */
export function confirmationForm(html: string): { action: string; inputs: Record<string, string> } | null {
  const $ = load(html);
  const button = $('#confirmation-button').first();
  if (button.length === 0) return null;
  const form = button.closest('form').length ? button.closest('form') : $('form').first();
  const action = form.attr('action');
  return action ? { action, inputs: formInputs($, form) } : null;
}

/** `session_code`, `execution`, `client_id`, `tab_id` from a URL or the page's form action. */
export function brokerParams(url: string, html: string): Record<'session_code' | 'execution' | 'client_id' | 'tab_id', string> | null {
  const read = (u: string) => {
    try {
      const p = new URL(u).searchParams;
      return { session_code: p.get('session_code') ?? '', execution: p.get('execution') ?? '', client_id: p.get('client_id') ?? '', tab_id: p.get('tab_id') ?? '' };
    } catch {
      return null;
    }
  };
  const fromUrl = read(url);
  if (fromUrl?.session_code && fromUrl.execution) return fromUrl;
  const action = firstForm(html).action;
  const fromForm = action ? read(new URL(action, url).toString()) : null;
  if (fromForm?.session_code && fromForm.execution) return fromForm;
  return null;
}
