/**
 * Interactive MitID login, start to tokens:
 *
 *   1. Aula authorize URL (PKCE + state), walk redirects to the UniLogin broker
 *      and pick the NemLog-in IdP, continue to the NemLog-in MitID page.
 *   2. NemLog-in initialize -> MitID core client (APP, or code token + password).
 *   3. Post the MitID code back to NemLog-in, pick an identity if asked.
 *   4. SAML to the broker, drive post-broker-login (guardian role, confirmation page).
 *   5. SAML to Aula's ACS, catch the redirect to app-private.aula.dk?code=...
 *   6. Exchange the code for tokens.
 *
 * Ported from Casperjuel/aula-mcp (MIT). Differences: every redirect hop is
 * checked for STIL's bot defense, the post-broker-login redirect is followed to
 * the end instead of one hop, every request has a timeout.
 */

import { BotDefenseError, LoginError } from '../errors.js';
import { base64url, generatePkce, randomBytes } from './crypto.js';
import {
  brokerForm,
  brokerParams,
  confirmationForm,
  type IdentityOption,
  identityOptions,
  metaRefreshUrl,
  samlForm,
  verificationToken,
} from './html.js';
import { HttpClient, type HttpResponse, hostAndPath } from './http.js';
import { type AppPrompt, type Authenticator, MitidClient, parseAux } from './mitid.js';
import { authorizeUrl, exchangeCode, OAUTH, type Tokens } from './oauth.js';

const NEMLOGIN = 'https://nemlog-in.mitid.dk';
const BOT_DEFENSE_HOSTS = new Set(['security-check.stil.dk']);

export interface LoginOptions {
  username: string;
  method: 'app' | 'token';
  /** APP: QR / OTP / status updates for the terminal. */
  onPrompt: (p: AppPrompt) => void;
  /** Code token: ask for the six digits. */
  askCodeToken?: () => Promise<string>;
  /** Code token: the MitID password. */
  askPassword?: () => Promise<string>;
  /** Several identities on one MitID: return a 1-based index. */
  chooseIdentity: (options: IdentityOption[]) => Promise<number>;
  /** Progress lines for the terminal. */
  onStep?: (message: string) => void;
  signal?: AbortSignal;
}

export interface LoginResult {
  tokens: Tokens;
  identity?: string;
}

export async function login(opts: LoginOptions): Promise<LoginResult> {
  const http = new HttpClient();
  const step = opts.onStep ?? (() => {});
  const guard = (url: string) => {
    const host = new URL(url).host;
    if (BOT_DEFENSE_HOSTS.has(host)) throw new BotDefenseError(host);
  };

  const pkce = generatePkce();
  const state = base64url(randomBytes(16));

  step('Opening Aula login');
  const mitidPage = await walkToMitid(http, authorizeUrl(state, pkce.challenge), guard);
  const token = verificationToken(mitidPage.body);
  if (!token) throw new LoginError('The NemLog-in page had no verification token.');

  const init = await http.request(`${NEMLOGIN}/login/mitid/initialize`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: NEMLOGIN,
      referer: `${NEMLOGIN}/login/mitid`,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ __RequestVerificationToken: token }),
  });
  if (init.status !== 200) throw new LoginError(`NemLog-in initialize failed (HTTP ${init.status}).`);

  const mitid = await MitidClient.start(http, parseAux(init.body));
  const offered = await mitid.identify(opts.username);
  step(`MitID user found (offers: ${offered.join(', ')})`);

  if (opts.method === 'app') {
    await mitid.approveWithApp(opts.onPrompt, opts.signal ? { signal: opts.signal } : {});
  } else {
    if (!opts.askCodeToken || !opts.askPassword) throw new LoginError('Code token login needs a digits and password prompt.');
    await mitid.approveWithCodeToken((await opts.askCodeToken()).replace(/\s/g, ''));
    await mitid.approveWithPassword(await opts.askPassword());
  }
  const mitidCode = await mitid.finalize();
  step('MitID approved, finishing Aula login');

  // Back to NemLog-in with the MitID code.
  const completion = new URLSearchParams({
    __RequestVerificationToken: token,
    NewCulture: '',
    MitIDUseConfirmed: 'True',
    MitIDAuthCode: mitidCode,
    MitIDAuthenticationCancelled: '',
    MitIDCoreClientError: '',
    SessionStorageActiveSessionUuid: (await http.cookie(`${NEMLOGIN}/login/mitid`, 'SessionUuid')) ?? '',
    SessionStorageActiveChallenge: (await http.cookie(`${NEMLOGIN}/login/mitid`, 'Challenge')) ?? '',
  });
  let page = (await http.follow(`${NEMLOGIN}/login/mitid`, { method: 'POST', body: completion }, { onHop: guard })).final;

  let identity: string | undefined;
  if (page.url.startsWith(`${NEMLOGIN}/loginoption`)) {
    const { options, inputs } = identityOptions(page.body);
    if (options.length === 0) throw new LoginError('NemLog-in asked for an identity but listed none.');
    const index = options.length === 1 ? 1 : await opts.chooseIdentity(options);
    const picked = options.find((o) => o.index === index);
    if (!picked) throw new LoginError(`No identity number ${index}.`);
    identity = picked.label;
    const body = new URLSearchParams(inputs);
    body.set('ChosenOptionJson', picked.loginOptionsJson);
    body.set('SessionStorageActiveSessionUuid', (await http.cookie(`${NEMLOGIN}/loginoption`, 'SessionUuid')) ?? completion.get('SessionStorageActiveSessionUuid') ?? '');
    body.set('SessionStorageActiveChallenge', (await http.cookie(`${NEMLOGIN}/loginoption`, 'Challenge')) ?? completion.get('SessionStorageActiveChallenge') ?? '');
    page = (await http.follow(`${NEMLOGIN}/loginoption`, { method: 'POST', body }, { onHop: guard })).final;
  }

  const nemloginSaml = samlForm(page.body);
  if (!nemloginSaml) throw new LoginError(`NemLog-in did not return a SAML response (ended at ${hostAndPath(page.url)}).`);

  const aulaSaml = await brokerHandoff(http, nemloginSaml.samlResponse, nemloginSaml.relayState, guard);
  const callback = await postToAula(http, aulaSaml.action || OAUTH.defaultAcs, aulaSaml.samlResponse, aulaSaml.relayState, guard);

  const params = new URL(callback).searchParams;
  if (params.get('state') !== state) throw new LoginError('OAuth state mismatch on the Aula callback.');
  const code = params.get('code');
  if (!code) throw new LoginError('The Aula callback carried no authorization code.');

  const tokens = await exchangeCode(http, code, pkce.verifier);
  return identity === undefined ? { tokens } : { tokens, identity };
}

/** Follow the authorize chain until the NemLog-in MitID page. */
async function walkToMitid(http: HttpClient, start: string, guard: (url: string) => void): Promise<HttpResponse> {
  let url = start;
  for (let hop = 0; hop < 20; hop++) {
    guard(url);
    const res = await http.request(url);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (res.status !== 200) throw new LoginError(`Login chain stopped with HTTP ${res.status} at ${hostAndPath(url)}.`);
    const host = new URL(url).host;
    if (host === 'nemlog-in.mitid.dk' || host === 'www.mitid.dk') return res;
    if (host === 'broker.unilogin.dk') {
      url = await chooseNemloginIdp(http, url, res.body);
      continue;
    }
    const refresh = metaRefreshUrl(res.body);
    if (refresh) {
      url = new URL(refresh, url).toString();
      continue;
    }
    throw new LoginError(`Login chain landed on an unexpected page: ${hostAndPath(url)}.`);
  }
  throw new LoginError('Login chain did not reach MitID within 20 hops.');
}

/**
 * The broker's IdP picker. `selectedIdp=nemlogin3` is what has worked for
 * years; the other field/value pairs are the upstream fallbacks in case it is
 * renamed. The first one that redirects wins.
 */
async function chooseNemloginIdp(http: HttpClient, pageUrl: string, html: string): Promise<string> {
  const { action, inputs } = brokerForm(html);
  if (!action) throw new LoginError('The UniLogin broker page has no form.');
  const target = new URL(action, pageUrl).toString();
  const tried: string[] = [];
  for (const field of ['selectedIdp', 'idp', 'authMethod', 'provider']) {
    for (const value of ['nemlogin3', 'mitid', 'MitID', 'nemlogin']) {
      const res = await http.request(target, { method: 'POST', body: new URLSearchParams({ ...inputs, [field]: value }) });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) return new URL(location, target).toString();
      tried.push(`${field}=${value}:${res.status}`);
    }
  }
  throw new LoginError(`Could not pick MitID on the UniLogin broker page (tried ${tried.join(', ')}).`, {
    hint: 'If your MitID is linked to a private organisation, the broker may need a different login option; that variant is not supported yet.',
  });
}

/** SAML into the broker; returns the SAML form bound for Aula. */
async function brokerHandoff(
  http: HttpClient,
  samlResponse: string,
  relayState: string,
  guard: (url: string) => void,
): Promise<{ action: string; samlResponse: string; relayState: string }> {
  const { final } = await http.follow(
    OAUTH.brokerSaml,
    {
      method: 'POST',
      headers: { origin: NEMLOGIN, referer: `${NEMLOGIN}/login/mitid` },
      body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }),
    },
    { onHop: guard },
  );
  if (final.status !== 200) throw new LoginError(`UniLogin broker answered HTTP ${final.status} at ${hostAndPath(final.url)}.`);

  const direct = samlForm(final.body);
  if (direct) return direct;

  const params = brokerParams(final.url, final.body);
  if (!params) {
    throw new LoginError(`UniLogin broker page had neither a SAML form nor session parameters (${hostAndPath(final.url)}).`);
  }
  const form = brokerForm(final.body);
  const inputs: Record<string, string> = { ...form.inputs };
  // Guardian role ("KONTAKT"), the only role this server is built for.
  if (form.hasRoleField) inputs['selected-aktoer'] = 'KONTAKT';

  const postUrl = `${OAUTH.postBrokerLogin}?${new URLSearchParams(params).toString()}`;
  let res = await http.request(postUrl, { method: 'POST', body: new URLSearchParams(inputs) });
  if (res.status === 200) {
    const confirm = confirmationForm(res.body);
    if (confirm) res = await http.request(new URL(confirm.action, postUrl).toString(), { method: 'POST', body: new URLSearchParams(confirm.inputs) });
  }
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new LoginError(`UniLogin post-broker-login answered HTTP ${res.status} without a redirect.`);
  }
  const { final: landing } = await http.follow(new URL(location, postUrl).toString(), {}, { onHop: guard });
  const toAula = samlForm(landing.body);
  if (!toAula) throw new LoginError(`No SAML form for Aula after the broker (${hostAndPath(landing.url)}).`);
  return toAula;
}

/** POST the SAML response to Aula and stop at the redirect to the app callback. */
async function postToAula(
  http: HttpClient,
  acs: string,
  samlResponse: string,
  relayState: string,
  guard: (url: string) => void,
): Promise<string> {
  let res = await http.request(acs, { method: 'POST', body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }) });
  for (let hop = 0; hop < 12; hop++) {
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    const next = new URL(location, res.url).toString();
    if (next.startsWith(OAUTH.redirectUri) && next.includes('code=')) return next;
    guard(next);
    res = await http.request(next);
  }
  throw new LoginError(`Aula did not redirect back with a code (stopped at ${hostAndPath(res.url)}, HTTP ${res.status}).`);
}

export type { Authenticator, IdentityOption, AppPrompt };
