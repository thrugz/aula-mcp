/**
 * MitID core-client protocol (www.mitid.dk JSON API) for the APP authenticator
 * and the code token ("kodeviser") + password pair. Ported from
 * Casperjuel/aula-mcp (MIT), itself a port of scaarup/aula's BrowserClient.
 */

import { LoginError } from '../errors.js';
import { pbkdf2Sha256, sha256 } from './crypto.js';
import { type FlowContext, flowProofMessage, signFlowProof } from './flow-proof.js';
import { type HttpClient, NetworkError } from './http.js';
import { MitidSrp } from './srp.js';

const MITID = 'https://www.mitid.dk';
const core = (id: string) => `${MITID}/mitid-core-client-backend/v1/authentication-sessions/${encodeURIComponent(id)}`;
const urls = {
  session: core,
  next: (id: string) => `${MITID}/mitid-core-client-backend/v2/authentication-sessions/${encodeURIComponent(id)}/next`,
  finalization: (id: string) => `${core(id)}/finalization`,
  app: (asid: string, step: 'init-auth' | 'init' | 'prove' | 'verify') =>
    `${MITID}/mitid-code-app-auth/v1/authenticator-sessions/web/${encodeURIComponent(asid)}/${step}`,
  codeToken: (asid: string, step: 'codetoken-init' | 'codetoken-prove') =>
    `${MITID}/mitid-code-token-auth/v1/authenticator-sessions/${encodeURIComponent(asid)}/${step}`,
  password: (asid: string, step: 'init' | 'password-prove') =>
    `${MITID}/mitid-password-auth/v1/authenticator-sessions/${encodeURIComponent(asid)}/${step}`,
};

export type Authenticator = 'APP' | 'CODE_TOKEN' | 'PASSWORD';

/**
 * Combination ids MitID offers after the identity claim. An app user can be
 * offered S3, S4 (app + chip) or L2; /next rejects an id it did not offer, so
 * the offered one is sent (scaarup #365). Unknown ids are skipped.
 */
const COMBINATIONS: Record<string, Authenticator> = { S3: 'APP', S4: 'APP', L2: 'APP', S1: 'CODE_TOKEN' };
const PREFERRED: Partial<Record<Authenticator, string>> = { APP: 'S3', CODE_TOKEN: 'S1' };

export function pickCombinations(offered: ReadonlyArray<{ id: string }>): Partial<Record<Authenticator, string>> {
  const out: Partial<Record<Authenticator, string>> = {};
  for (const { id } of offered) {
    const kind = COMBINATIONS[id];
    if (!kind) continue;
    if (!out[kind] || id === PREFERRED[kind]) out[kind] = id;
  }
  return out;
}

export class MitidError extends LoginError {}

export class MitidParallelSessionError extends MitidError {
  constructor() {
    super('MitID reports the account is already in a login elsewhere (parallel session).', {
      hint: 'Close other Aula/MitID login tabs, wait about a minute, then run `aula-mcp login` again.',
    });
  }
}

interface NextAuthenticator {
  authenticatorType: string;
  authenticatorSessionFlowKey: string;
  eafeHash: string;
  authenticatorSessionId: string;
}

interface NextResponse {
  nextAuthenticator?: NextAuthenticator;
  combinations?: Array<{ id: string }>;
  errors?: Array<{ errorCode?: string; message?: string; userMessage?: { supportErrorId?: string; text?: { text?: string } } }>;
  nextSessionId?: string;
}

/** Parse NemLog-in's `/login/mitid/initialize` body: a JSON string holding JSON, whose `Aux` is base64 JSON. */
export function parseAux(body: string): { clientHash: string; authenticationSessionId: string } {
  let outer: unknown = JSON.parse(body);
  if (typeof outer === 'string') outer = JSON.parse(outer);
  const aux = (outer as { Aux?: string })?.Aux;
  if (!aux) throw new MitidError('MitID initialize response has no Aux field');
  const inner = JSON.parse(Buffer.from(aux, 'base64').toString('utf8')) as {
    coreClient?: { checksum?: string };
    parameters?: { authenticationSessionId?: string };
  };
  const checksum = inner.coreClient?.checksum;
  const sessionId = inner.parameters?.authenticationSessionId;
  if (!checksum || !sessionId) throw new MitidError('MitID Aux is missing the checksum or session id');
  return { clientHash: Buffer.from(checksum, 'base64').toString('hex'), authenticationSessionId: sessionId };
}

/** What the APP poll loop reports to the UI. */
export type AppPrompt =
  | { kind: 'waiting' }
  | { kind: 'qr'; frames: [string, string]; updateCount: number }
  | { kind: 'otp'; code: string }
  | { kind: 'verified' };

/** The two halves of the animated MitID QR, as the app expects them. */
export function qrFrames(channelBindingValue: string, updateCount: number): [string, string] {
  const half = Math.floor(channelBindingValue.length / 2);
  const frame = (p: 1 | 2, h: string) => JSON.stringify({ v: 1, p, t: 2, h, uc: updateCount });
  return [frame(1, channelBindingValue.slice(0, half)), frame(2, channelBindingValue.slice(half))];
}

export class MitidClient {
  private readonly http: HttpClient;
  private readonly clientHash: string;
  private readonly sessionId: string;
  private ctx = { brokerSecurityContext: '', serviceProviderName: '', referenceTextHeader: '', referenceTextBody: '' };
  private current?: NextAuthenticator & { kind: Authenticator };
  private offered: Partial<Record<Authenticator, string>> = {};
  private finalizationSessionId?: string;
  /** Cancels in-flight requests, including the ~25 s app long-poll. */
  private signal?: AbortSignal;

  private constructor(http: HttpClient, aux: { clientHash: string; authenticationSessionId: string }) {
    this.http = http;
    this.clientHash = aux.clientHash;
    this.sessionId = aux.authenticationSessionId;
  }

  static async start(http: HttpClient, aux: { clientHash: string; authenticationSessionId: string }): Promise<MitidClient> {
    const client = new MitidClient(http, aux);
    const res = await http.request(urls.session(client.sessionId));
    if (res.status !== 200) throw new MitidError(`MitID session lookup failed (HTTP ${res.status})`);
    const s = JSON.parse(res.body) as typeof client.ctx;
    client.ctx = {
      brokerSecurityContext: s.brokerSecurityContext ?? '',
      serviceProviderName: s.serviceProviderName ?? '',
      referenceTextHeader: s.referenceTextHeader ?? '',
      referenceTextBody: s.referenceTextBody ?? '',
    };
    return client;
  }

  /** Claim the MitID identity; returns the authenticators the account offers. */
  async identify(username: string): Promise<Authenticator[]> {
    const res = await this.json(urls.session(this.sessionId), { identityClaim: username }, 'PUT');
    if (res.status !== 200) {
      const code = safeJson<{ errorCode?: string }>(res.body)?.errorCode;
      if (code === 'control.identity_not_found') {
        throw new MitidError(`MitID has no user "${username}".`, { hint: 'Check AULA_MITID_USERNAME (the MitID user ID, not an email).' });
      }
      throw new MitidError(`MitID identity claim failed (HTTP ${res.status}${code ? `, ${code}` : ''})`);
    }
    const next = await this.next('');
    this.apply(next);
    this.offered = pickCombinations(next.combinations ?? []);
    return Object.keys(this.offered) as Authenticator[];
  }

  /** Drive the MitID app: show QR/OTP via `onPrompt` until the user approves. */
  async approveWithApp(onPrompt: (p: AppPrompt) => void, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
    this.signal = opts.signal;
    await this.select('APP');
    const asid = this.cur().authenticatorSessionId;
    const init = await this.json(urls.app(asid, 'init-auth'), {});
    if (init.status !== 200) throw new MitidError(`MitID app start failed (HTTP ${init.status})`);
    const { pollUrl, ticket, errorCode } = JSON.parse(init.body) as { pollUrl: string; ticket: string; errorCode?: string };
    if (errorCode === 'auth.codeapp.authentication.parallel_sessions_detected') throw new MitidParallelSessionError();

    onPrompt({ kind: 'waiting' });
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    let lastUpdate = -1;
    let lastOtp = '';
    let failures = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new MitidError('Login cancelled.');
      if (Date.now() > deadline) throw new MitidError('Timed out waiting for MitID app approval.');
      let poll: { status: number; body: string };
      try {
        // MitID long-polls for about 25 s before answering "timeout".
        poll = await this.json(pollUrl, { ticket }, 'POST', 60_000);
      } catch (e) {
        if (e instanceof NetworkError && ++failures <= 3) continue;
        throw e;
      }
      if (poll.status >= 500 && ++failures <= 3) continue;
      if (poll.status !== 200) throw new MitidError(`MitID app poll failed (HTTP ${poll.status})`);
      failures = 0;
      const p = JSON.parse(poll.body) as {
        status: string;
        channelBindingValue?: string;
        updateCount?: number;
        confirmation?: boolean;
        payload?: { response: string; responseSignature: string };
      };
      switch (p.status) {
        case 'timeout':
          break;
        case 'channel_validation_tqr':
          if (p.channelBindingValue && p.updateCount !== undefined && p.updateCount !== lastUpdate) {
            lastUpdate = p.updateCount;
            onPrompt({ kind: 'qr', frames: qrFrames(p.channelBindingValue, p.updateCount), updateCount: p.updateCount });
          }
          break;
        case 'channel_validation_otp':
          if (p.channelBindingValue && p.channelBindingValue !== lastOtp) {
            lastOtp = p.channelBindingValue;
            onPrompt({ kind: 'otp', code: p.channelBindingValue });
          }
          break;
        case 'channel_verified':
          onPrompt({ kind: 'verified' });
          break;
        case 'OK':
          if (p.confirmation === true && p.payload) {
            await this.completeApp(p.payload.response, p.payload.responseSignature);
            return;
          }
          throw new MitidError('MitID app login was rejected in the app.');
        default:
          throw new MitidError(`Unexpected MitID app status: ${p.status}`);
      }
      await sleep(1000, opts.signal);
    }
  }

  /** SRP proof after app approval: init, prove (verify M2), verify (encAuth), next. */
  private async completeApp(response: string, responseSignature: string): Promise<void> {
    const cur = this.cur();
    const started = Date.now();
    const srp = new MitidSrp();
    const init = await this.json(urls.app(cur.authenticatorSessionId, 'init'), { randomA: { value: srp.publicAHex } });
    if (init.status !== 200) throw new MitidError(`MitID app init failed (HTTP ${init.status})`);
    const { srpSalt, randomB } = JSON.parse(init.body) as { srpSalt: { value: string }; randomB: { value: string } };

    const passwordHex = sha256(
      Buffer.concat([Buffer.from(response, 'base64'), Buffer.from(cur.authenticatorSessionFlowKey, 'utf8')]),
    ).toString('hex');
    const { m1Hex, K } = srp.prove({
      srpSaltHex: srpSalt.value,
      randomBHex: randomB.value,
      passwordHex,
      authSessionId: cur.authenticatorSessionId,
    });
    const prove = await this.json(urls.app(cur.authenticatorSessionId, 'prove'), {
      m1: { value: m1Hex },
      flowValueProof: { value: signFlowProof(flowProofMessage(this.flowContext()), K, 'flowValues') },
    });
    if (prove.status !== 200) throw new MitidError(`MitID app prove failed (HTTP ${prove.status})`);
    const m2 = (JSON.parse(prove.body) as { m2?: { value?: string } }).m2?.value;
    if (!m2 || !srp.verifyServer(m2)) throw new MitidError('MitID server proof (M2) did not verify.');

    const encAuth = srp.seal(Buffer.from(responseSignature, 'base64')).toString('base64');
    const verify = await this.json(urls.app(cur.authenticatorSessionId, 'verify'), {
      encAuth,
      frontEndProcessingTime: Date.now() - started,
    });
    if (verify.status !== 204) throw new MitidError(`MitID app verify failed (HTTP ${verify.status})`);
    this.finish(await this.next(''));
  }

  /** Code token (kodeviser) step; leaves the client on the PASSWORD step. */
  async approveWithCodeToken(digits: string): Promise<void> {
    await this.select('CODE_TOKEN');
    const cur = this.cur();
    const srp = new MitidSrp();
    const init = await this.json(urls.codeToken(cur.authenticatorSessionId, 'codetoken-init'), { randomA: { value: srp.publicAHex } });
    if (init.status !== 200) throw new MitidError(`MitID code token init failed (HTTP ${init.status})`);
    const { srpSalt, randomB } = JSON.parse(init.body) as { srpSalt: { value: string }; randomB: { value: string } };
    const { m1Hex, K } = srp.prove({
      srpSaltHex: srpSalt.value,
      randomBHex: randomB.value,
      passwordHex: Buffer.from(cur.authenticatorSessionFlowKey, 'utf8').toString('hex'),
      authSessionId: cur.authenticatorSessionId,
    });
    const prove = await this.json(urls.codeToken(cur.authenticatorSessionId, 'codetoken-prove'), {
      m1: { value: m1Hex },
      flowValueProof: { value: signFlowProof(flowProofMessage(this.flowContext()), K, `OTP${digits}`) },
      frontEndProcessingTime: 100,
    });
    if (prove.status !== 204) throw new MitidError(`MitID code token prove failed (HTTP ${prove.status})`);
    const next = await this.next('', { allowErrors: true });
    if (next.errors?.[0]?.errorCode === 'TOTP_INVALID') throw new MitidError('The code token digits were rejected.');
    this.assertNoErrors(next);
    if (next.nextAuthenticator?.authenticatorType !== 'PASSWORD') {
      throw new MitidError('MitID did not ask for the password after the code token.');
    }
    this.apply(next);
  }

  /** Password step after the code token. */
  async approveWithPassword(password: string): Promise<void> {
    const cur = this.cur();
    if (cur.kind !== 'PASSWORD') throw new MitidError('MitID is not at the password step.');
    const srp = new MitidSrp();
    const init = await this.json(urls.password(cur.authenticatorSessionId, 'init'), { randomA: { value: srp.publicAHex } });
    if (init.status !== 200) throw new MitidError(`MitID password init failed (HTTP ${init.status})`);
    const { srpSalt, randomB, pbkdf2Salt } = JSON.parse(init.body) as {
      srpSalt: { value: string };
      randomB: { value: string };
      pbkdf2Salt?: { value: string };
    };
    if (!pbkdf2Salt) throw new MitidError('MitID password init returned no PBKDF2 salt.');
    const passwordHex = pbkdf2Sha256(password, Buffer.from(pbkdf2Salt.value, 'hex'), 20_000, 32).toString('hex');
    const { m1Hex, K } = srp.prove({
      srpSaltHex: srpSalt.value,
      randomBHex: randomB.value,
      passwordHex,
      authSessionId: cur.authenticatorSessionId,
    });
    const prove = await this.json(urls.password(cur.authenticatorSessionId, 'password-prove'), {
      m1: { value: m1Hex },
      flowValueProof: { value: signFlowProof(flowProofMessage(this.flowContext()), K, 'flowValues') },
      frontEndProcessingTime: 100,
    });
    if (prove.status !== 204) throw new MitidError(`MitID password prove failed (HTTP ${prove.status})`);
    const next = await this.next('', { allowErrors: true });
    if (next.errors?.length) throw new MitidError('The MitID password was rejected.');
    this.finish(next);
  }

  /** Exchange the completed MitID session for the authorization code NemLog-in wants. */
  async finalize(): Promise<string> {
    if (!this.finalizationSessionId) throw new MitidError('MitID finalize called before approval.');
    const res = await this.http.request(urls.finalization(this.finalizationSessionId), { method: 'PUT' });
    if (res.status !== 200) throw new MitidError(`MitID finalization failed (HTTP ${res.status})`);
    const code = (JSON.parse(res.body) as { authorizationCode?: string }).authorizationCode;
    if (!code) throw new MitidError('MitID finalization returned no authorization code.');
    return code;
  }

  // --- internals -------------------------------------------------------------

  private async select(kind: Authenticator): Promise<void> {
    if (this.current?.kind === kind) return;
    // No combinations listed at all: fall back to the static id, as upstream does.
    const id = Object.keys(this.offered).length === 0 ? PREFERRED[kind] : this.offered[kind];
    if (!id) {
      throw new MitidError(`This MitID account does not offer ${kind === 'APP' ? 'the MitID app' : 'a code token'}.`, {
        hint: `Available: ${Object.keys(this.offered).join(', ') || 'none'}. Use --method ${kind === 'APP' ? 'token' : 'app'}.`,
      });
    }
    this.apply(await this.next(id));
    if (this.current?.kind !== kind) throw new MitidError(`Asked MitID for ${kind}, got ${this.current?.kind ?? 'nothing'}.`);
  }

  private async next(combinationId: string, opts: { allowErrors?: boolean } = {}): Promise<NextResponse> {
    const res = await this.json(urls.next(this.sessionId), { combinationId });
    if (res.status !== 200) throw new MitidError(`MitID /next failed (HTTP ${res.status})`);
    const next = JSON.parse(res.body) as NextResponse;
    if (!opts.allowErrors) this.assertNoErrors(next);
    return next;
  }

  private assertNoErrors(next: NextResponse): void {
    const err = next.errors?.[0];
    if (!err) return;
    const text = err.userMessage?.text?.text ?? err.message ?? err.errorCode ?? 'unknown error';
    if (err.userMessage?.supportErrorId === 'CAP008' || /two places at the same time|parallel/i.test(text)) {
      throw new MitidParallelSessionError();
    }
    throw new MitidError(`MitID: ${text}${err.errorCode ? ` (${err.errorCode})` : ''}`);
  }

  private apply(next: NextResponse): void {
    const n = next.nextAuthenticator;
    if (!n) throw new MitidError('MitID returned no next authenticator.');
    const kind = (n.authenticatorType === 'TOKEN' ? 'CODE_TOKEN' : n.authenticatorType) as Authenticator;
    this.current = { ...n, kind };
  }

  private finish(next: NextResponse): void {
    this.assertNoErrors(next);
    if (!next.nextSessionId) throw new MitidError('MitID approval finished without a session to finalize.');
    this.finalizationSessionId = next.nextSessionId;
  }

  private cur(): NextAuthenticator & { kind: Authenticator } {
    if (!this.current) throw new MitidError('No MitID authenticator selected.');
    return this.current;
  }

  private flowContext(): FlowContext {
    const c = this.cur();
    return {
      authenticatorSessionId: c.authenticatorSessionId,
      authenticatorSessionFlowKey: c.authenticatorSessionFlowKey,
      clientHash: this.clientHash,
      eafeHash: c.eafeHash,
      ...this.ctx,
    };
  }

  private async json(url: string, body: unknown, method: 'POST' | 'PUT' = 'POST', timeoutMs?: number) {
    return this.http.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(this.signal ? { signal: this.signal } : {}),
    });
  }
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new MitidError('Login cancelled.'));
    }, { once: true });
  });
}
