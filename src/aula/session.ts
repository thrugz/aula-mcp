/**
 * Access-token lifecycle for the server process. Tokens are refreshed when
 * they have less than five minutes left, under the cross-process lock, and the
 * record is re-read inside the lock so a refresh done by another process (the
 * CLI, a second MCP client) is picked up instead of repeated.
 */

import { HttpClient } from '../auth/http.js';
import { refreshTokens } from '../auth/oauth.js';
import { ReauthRequiredError } from '../errors.js';
import { log } from '../log.js';
import { loadRecord, saveRecord, type TokenRecord, withRefreshLock } from '../store/tokens.js';

const REFRESH_MARGIN_S = 300;

export interface TokenSource {
  accessToken(): Promise<string>;
  /** Called after Aula rejected the current token; returns a fresh one. */
  renew(rejected: string): Promise<string>;
  record(): Promise<TokenRecord | undefined>;
  /** Seconds since the current access token was issued, if known. */
  tokenAgeSeconds(): Promise<number | undefined>;
}

export class TokenSession implements TokenSource {
  private cached?: TokenRecord;
  private inflight?: Promise<TokenRecord>;
  private readonly http = new HttpClient();

  async record(): Promise<TokenRecord | undefined> {
    return this.cached ?? (await loadRecord());
  }

  async tokenAgeSeconds(): Promise<number | undefined> {
    const rec = this.cached ?? (await loadRecord());
    return rec ? now() - rec.tokens.obtained_at : undefined;
  }

  async accessToken(): Promise<string> {
    const rec = this.cached ?? (await this.load());
    if (rec.tokens.expires_at - now() > REFRESH_MARGIN_S) return rec.tokens.access_token;
    return (await this.refresh(rec.tokens.access_token)).tokens.access_token;
  }

  async renew(rejected: string): Promise<string> {
    return (await this.refresh(rejected)).tokens.access_token;
  }

  private async load(): Promise<TokenRecord> {
    const rec = await loadRecord();
    if (!rec) throw new ReauthRequiredError('Not logged in to Aula yet.');
    this.cached = rec;
    return rec;
  }

  private refresh(stale: string): Promise<TokenRecord> {
    this.inflight ??= withRefreshLock(async () => {
      const latest = await loadRecord();
      if (!latest) throw new ReauthRequiredError('Not logged in to Aula yet.');
      // Another process already refreshed: use its token instead of rotating again.
      if (latest.tokens.access_token !== stale && latest.tokens.expires_at - now() > REFRESH_MARGIN_S) {
        this.cached = latest;
        return latest;
      }
      log.debug('token.refresh');
      const tokens = await refreshTokens(this.http, latest.tokens.refresh_token);
      const next: TokenRecord = { ...latest, tokens, saved_at: now() };
      await saveRecord(next);
      this.cached = next;
      return next;
    }).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
}

const now = () => Math.floor(Date.now() / 1000);
