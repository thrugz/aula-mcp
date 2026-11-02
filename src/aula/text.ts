/** HTML to readable text, and output size discipline. */

import * as cheerio from 'cheerio';

/** Convert HTML (or text with entities) to plain text, keeping paragraph and list breaks. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html.trim();
  const $ = cheerio.load(`<body>${html}</body>`);
  $('script, style').remove();
  $('br').replaceWith('\n');
  $('li').each((_, el) => {
    $(el).prepend('- ');
  });
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr, ul, ol, table').each((_, el) => {
    $(el).append('\n');
  });
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const text = $(el).text().trim();
    if (/^https?:/i.test(href) && text && !text.includes(href)) $(el).append(` (${href})`);
  });
  return $('body')
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Shorten to `max` characters on a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()} [...]`;
}

/** One line: collapse whitespace, then clip. */
export function oneLine(text: string, max = 160): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

/**
 * Join output blocks until `budget` characters, then say how many were left
 * out so the model can narrow the query instead of assuming it saw everything.
 */
export function withinBudget(blocks: string[], budget: number, what: string): string {
  const out: string[] = [];
  let used = 0;
  for (const [i, block] of blocks.entries()) {
    if (used + block.length > budget && out.length > 0) {
      out.push(`[${blocks.length - i} more ${what} not shown: output limit reached. Narrow the date range or filter by child.]`);
      break;
    }
    out.push(block);
    used += block.length + 1;
  }
  return out.join('\n');
}
