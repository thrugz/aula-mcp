/**
 * End-to-end login against a simulated Aula / UniLogin / NemLog-in / MitID
 * chain. The fake MitID server runs the server side of the SRP exchange
 * (v = g^x, B = kv + g^b, S = (A v^u)^b) and checks M1, the flowValueProof and
 * the encrypted signature, so the client's protocol math is verified from the
 * other end, not only against recorded vectors.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { aesGcmOpen, bigIntToBytes, bytesToBigInt, hexToBigInt, randomBytes, sha256 } from '../src/auth/crypto.js';
import { flowProofMessage, signFlowProof } from '../src/auth/flow-proof.js';
import { login } from '../src/auth/login.js';
import { modPow, SRP_G, SRP_N } from '../src/auth/srp.js';
import { BotDefenseError } from '../src/errors.js';
import { empty, FakeFetch, html, json, redirect } from './helpers/fake-fetch.js';

const N_BYTES = 384;
const H = (s: Buffer | string) => bytesToBigInt(sha256(s));

function fakeJwt(exp: number): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b({ exp, sub: 'x' })}.c2ln`;
}

/** Builds the whole fake chain. `opts` toggles the variant pages. */
function fakeChain(opts: { botDefense?: boolean } = {}) {
  const f = new FakeFetch();
  const flow = {
    authSessionId: 'auth-sess-1',
    asid: 'app-asid-1',
    flowKey: 'flow-key-xyz',
    eafe: 'eafe-hash',
    checksum: randomBytes(32),
    session: { brokerSecurityContext: 'bsc', serviceProviderName: 'Aula', referenceTextHeader: 'Log på Aula', referenceTextBody: 'Body' },
    response: randomBytes(48),
    signature: randomBytes(64),
    salt: 'a1b2c3d4'.repeat(8),
    b: bytesToBigInt(randomBytes(32)),
    A: 0n,
    B: 0n,
    K: Buffer.alloc(0),
    state: '',
    challenge: '',
  };
  const passwordHex = () => sha256(Buffer.concat([flow.response, Buffer.from(flow.flowKey, 'utf8')])).toString('hex');
  const x = () => hexToBigInt(sha256(flow.salt + passwordHex()).toString('hex'));
  const k = H(Buffer.concat([Buffer.from(SRP_N.toString(), 'utf8'), bigIntToBytes(SRP_G, N_BYTES)]));

  f.on('GET', 'https://login.aula.dk/simplesaml/module.php/oidc/authorize.php', (r) => {
    flow.state = r.url.searchParams.get('state') ?? '';
    flow.challenge = r.url.searchParams.get('code_challenge') ?? '';
    return redirect(opts.botDefense ? 'https://security-check.stil.dk/challenge' : 'https://broker.unilogin.dk/auth/realms/broker/login?tab=1');
  })
    .on('GET', 'https://broker.unilogin.dk/auth/realms/broker/login', () =>
      html('<form action="/auth/realms/broker/idp-select" method="post"><input type="hidden" name="csrf" value="c1"></form>'),
    )
    .on('POST', 'https://broker.unilogin.dk/auth/realms/broker/idp-select', (r) =>
      new URLSearchParams(r.body).get('selectedIdp') === 'nemlogin3' && new URLSearchParams(r.body).get('csrf') === 'c1'
        ? redirect('https://nemlog-in.mitid.dk/login/mitid')
        : empty(400),
    )
    .on('GET', 'https://nemlog-in.mitid.dk/login/mitid', () =>
      html('<form><input type="hidden" name="__RequestVerificationToken" value="rvt-1"></form>', {
        'set-cookie': 'SessionUuid=su-1; Path=/; Secure',
      }),
    )
    .on('POST', 'https://nemlog-in.mitid.dk/login/mitid/initialize', (r) => {
      expect(new URLSearchParams(r.body).get('__RequestVerificationToken')).toBe('rvt-1');
      const aux = Buffer.from(JSON.stringify({ coreClient: { checksum: flow.checksum.toString('base64') }, parameters: { authenticationSessionId: flow.authSessionId } })).toString('base64');
      return new Response(JSON.stringify(JSON.stringify({ Aux: aux })), { status: 200 });
    })
    .on('GET', `https://www.mitid.dk/mitid-core-client-backend/v1/authentication-sessions/${flow.authSessionId}`, () => json(flow.session))
    .on('PUT', `https://www.mitid.dk/mitid-core-client-backend/v1/authentication-sessions/${flow.authSessionId}`, (r) =>
      JSON.parse(r.body).identityClaim === 'parent01' ? json({}) : json({ errorCode: 'control.identity_not_found' }, 400),
    )
    .on('POST', `https://www.mitid.dk/mitid-core-client-backend/v2/authentication-sessions/${flow.authSessionId}/next`, (r) => {
      const { combinationId } = JSON.parse(r.body);
      if (combinationId === '' && flow.K.length === 0) {
        return json({
          nextAuthenticator: { authenticatorType: 'PASSWORD', authenticatorSessionFlowKey: 'pw', eafeHash: 'e', authenticatorSessionId: 'pw-asid' },
          combinations: [{ id: 'S4', combinationItems: [{ name: 'APP' }] }, { id: 'S1', combinationItems: [{ name: 'TOKEN' }] }, { id: 'X9' }],
        });
      }
      if (combinationId === 'S4') {
        return json({ nextAuthenticator: { authenticatorType: 'APP', authenticatorSessionFlowKey: flow.flowKey, eafeHash: flow.eafe, authenticatorSessionId: flow.asid } });
      }
      if (combinationId === '' && flow.K.length) return json({ nextSessionId: 'final-sess' });
      return json({ errors: [{ errorCode: 'bad_combination' }] });
    })
    .on('POST', `https://www.mitid.dk/mitid-code-app-auth/v1/authenticator-sessions/web/${flow.asid}/init-auth`, () =>
      json({ pollUrl: 'https://www.mitid.dk/mitid-code-app-auth/v1/poll', ticket: 'ticket-1' }),
    );

  let polls = 0;
  f.on('POST', 'https://www.mitid.dk/mitid-code-app-auth/v1/poll', (r) => {
    expect(JSON.parse(r.body).ticket).toBe('ticket-1');
    polls++;
    if (polls === 1) return json({ status: 'channel_validation_tqr', channelBindingValue: 'aabbccdd', updateCount: 1 });
    if (polls === 2) return json({ status: 'channel_verified' });
    return json({ status: 'OK', confirmation: true, payload: { response: flow.response.toString('base64'), responseSignature: flow.signature.toString('base64') } });
  })
    .on('POST', `https://www.mitid.dk/mitid-code-app-auth/v1/authenticator-sessions/web/${flow.asid}/init`, (r) => {
      flow.A = hexToBigInt(JSON.parse(r.body).randomA.value);
      const v = modPow(SRP_G, x(), SRP_N);
      flow.B = (k * v + modPow(SRP_G, flow.b, SRP_N)) % SRP_N;
      return json({ srpSalt: { value: flow.salt }, randomB: { value: flow.B.toString(16) } });
    })
    .on('POST', `https://www.mitid.dk/mitid-code-app-auth/v1/authenticator-sessions/web/${flow.asid}/prove`, (r) => {
      const body = JSON.parse(r.body);
      const u = H(Buffer.concat([bigIntToBytes(flow.A, N_BYTES), bigIntToBytes(flow.B, N_BYTES)])) % SRP_N;
      const v = modPow(SRP_G, x(), SRP_N);
      const S = modPow(flow.A * modPow(v, u, SRP_N), flow.b, SRP_N);
      flow.K = sha256(S.toString());
      const I = sha256(flow.asid).toString('hex');
      const xor = H(SRP_N.toString()) ^ H(SRP_G.toString());
      const m1 = sha256(xor.toString() + I + flow.salt + flow.A.toString() + flow.B.toString() + flow.K.toString('hex')).toString('hex');
      if (body.m1.value !== m1) return json({ errorCode: 'm1_mismatch' }, 400);
      const proof = signFlowProof(
        flowProofMessage({
          authenticatorSessionId: flow.asid,
          authenticatorSessionFlowKey: flow.flowKey,
          clientHash: flow.checksum.toString('hex'),
          eafeHash: flow.eafe,
          ...flow.session,
        }),
        flow.K,
        'flowValues',
      );
      if (body.flowValueProof.value !== proof) return json({ errorCode: 'proof_mismatch' }, 400);
      const m2 = sha256(flow.A.toString() + hexToBigInt(m1).toString() + flow.K.toString('hex')).toString('hex');
      return json({ m2: { value: m2 } });
    })
    .on('POST', `https://www.mitid.dk/mitid-code-app-auth/v1/authenticator-sessions/web/${flow.asid}/verify`, (r) => {
      const { encAuth, frontEndProcessingTime } = JSON.parse(r.body);
      expect(typeof frontEndProcessingTime).toBe('number');
      const plain = aesGcmOpen(flow.K, Buffer.from(encAuth, 'base64'));
      return plain.equals(flow.signature) ? empty(204) : json({ errorCode: 'bad_sig' }, 400);
    })
    .on('PUT', 'https://www.mitid.dk/mitid-core-client-backend/v1/authentication-sessions/final-sess/finalization', () =>
      json({ authorizationCode: 'mitid-auth-code' }),
    )
    .on('POST', 'https://nemlog-in.mitid.dk/login/mitid', (r) => {
      const p = new URLSearchParams(r.body);
      expect(p.get('MitIDAuthCode')).toBe('mitid-auth-code');
      expect(p.get('SessionStorageActiveSessionUuid')).toBe('su-1');
      return redirect('/loginoption');
    })
    .on('GET', 'https://nemlog-in.mitid.dk/loginoption', () =>
      html(`<form method="post"><input type="hidden" name="__RequestVerificationToken" value="rvt-2">
        <div class="list-link-box"><a class="list-link" data-loginoptions='{"id":1}'><div class="list-link-text">Privat</div></a></div>
        <div class="list-link-box"><a class="list-link" data-loginoptions='{"id":2}'><div class="list-link-text">Forælder på Skolen</div></a></div></form>`),
    )
    .on('POST', 'https://nemlog-in.mitid.dk/loginoption', (r) => {
      expect(new URLSearchParams(r.body).get('ChosenOptionJson')).toBe('{"id":2}');
      return html('<form action="https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3/endpoint" method="post"><input type="hidden" name="SAMLResponse" value="nem-saml"></form>');
    })
    .on('POST', 'https://broker.unilogin.dk/auth/realms/broker/broker/nemlogin3/endpoint', (r) => {
      expect(new URLSearchParams(r.body).get('SAMLResponse')).toBe('nem-saml');
      return redirect('/auth/realms/broker/login-actions/first-broker-login?client_id=aula');
    })
    .on('GET', 'https://broker.unilogin.dk/auth/realms/broker/login-actions/first-broker-login', () =>
      redirect('/auth/realms/broker/login-actions/post-broker-login?session_code=sc1&execution=ex1&client_id=aula&tab_id=t1'),
    )
    .on('GET', 'https://broker.unilogin.dk/auth/realms/broker/login-actions/post-broker-login', () =>
      html('<form action="?x=1" method="post"><input type="hidden" name="hid" value="h1"><input type="radio" name="selected-aktoer" value="KONTAKT"></form>'),
    )
    .on('POST', 'https://broker.unilogin.dk/auth/realms/broker/login-actions/post-broker-login', (r) => {
      expect(r.url.searchParams.get('session_code')).toBe('sc1');
      const p = new URLSearchParams(r.body);
      expect(p.get('selected-aktoer')).toBe('KONTAKT');
      expect(p.get('hid')).toBe('h1');
      return html('<form action="/auth/realms/broker/confirm"><input type="hidden" name="c" value="ok"><button id="confirmation-button">Fortsæt</button></form>');
    })
    .on('POST', 'https://broker.unilogin.dk/auth/realms/broker/confirm', () => redirect('/auth/realms/broker/hop1'))
    .on('GET', 'https://broker.unilogin.dk/auth/realms/broker/hop1', () => redirect('/auth/realms/broker/hop2'))
    .on('GET', 'https://broker.unilogin.dk/auth/realms/broker/hop2', () =>
      html('<form action="https://login.aula.dk/simplesaml/module.php/saml/sp/saml2-acs.php/app-level3-sp" method="post"><input type="hidden" name="SAMLResponse" value="aula-saml"><input type="hidden" name="RelayState" value="rs"></form>'),
    )
    .on('POST', 'https://login.aula.dk/simplesaml/module.php/saml/sp/saml2-acs.php/app-level3-sp', () => redirect('https://login.aula.dk/next'))
    .on('GET', 'https://login.aula.dk/next', () => redirect(`https://app-private.aula.dk?code=aula-code&state=${encodeURIComponent(flow.state)}`))
    .on('POST', 'https://login.aula.dk/simplesaml/module.php/oidc/token.php', (r) => {
      const p = new URLSearchParams(r.body);
      expect(p.get('grant_type')).toBe('authorization_code');
      expect(p.get('code')).toBe('aula-code');
      expect(sha256(p.get('code_verifier')!).toString('base64url')).toBe(flow.challenge);
      return json({ access_token: fakeJwt(2_000_000_000), refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    })
    .on('GET', 'https://security-check.stil.dk/challenge', () => html('<script>challenge()</script>'));
  return { f, flow };
}

afterEach(() => vi.unstubAllGlobals());

describe('login (simulated chain)', () => {
  it('completes the APP flow, identity choice, broker confirmation and token exchange', async () => {
    const { f } = fakeChain();
    f.install();
    const prompts: string[] = [];
    let offered: string[] = [];
    const result = await login({
      username: 'parent01',
      method: 'app',
      onPrompt: (p) => prompts.push(p.kind),
      chooseIdentity: async (options) => {
        offered = options.map((o) => o.label);
        return 2;
      },
    });
    expect(result.tokens.access_token.split('.')).toHaveLength(3);
    expect(result.tokens.refresh_token).toBe('refresh-1');
    expect(result.tokens.expires_at).toBe(2_000_000_000);
    expect(result.identity).toBe('Forælder på Skolen');
    expect(offered).toEqual(['Privat', 'Forælder på Skolen']);
    expect(prompts).toEqual(['waiting', 'qr', 'verified']);
    // The S4-only account got S4, not the static S3 (scaarup #365).
    const selections = f.calls
      .filter((c) => c.url.host === 'www.mitid.dk' && c.url.pathname.endsWith('/next'))
      .map((c) => JSON.parse(c.body).combinationId);
    expect(selections).toContain('S4');
    expect(selections).not.toContain('S3');
  });

  it('stops with a clear error on STIL bot defense', async () => {
    const { f } = fakeChain({ botDefense: true });
    f.install();
    await expect(login({ username: 'parent01', method: 'app', onPrompt: () => {}, chooseIdentity: async () => 1 })).rejects.toBeInstanceOf(BotDefenseError);
  });

  it('reports an unknown MitID user', async () => {
    const { f } = fakeChain();
    f.install();
    await expect(login({ username: 'nobody', method: 'app', onPrompt: () => {}, chooseIdentity: async () => 1 })).rejects.toThrow(/no user "nobody"/);
  });
});
