/**
 * MitID's SRP-6a variant. Ported from Casperjuel/aula-mcp (MIT), which ported
 * it from the Python reference (scaarup/aula, CustomSRP.py).
 *
 * Not textbook SRP, so no SRP library will do:
 *   - custom 3072-bit prime N (not an RFC 5054 group), g = 2
 *   - k = SHA256(decimal(N) || g left-padded to |N|)
 *   - u = SHA256(A padded || B padded) mod N
 *   - K = SHA256(decimal(S))
 *   - M1 = SHA256(decimal(H(N) xor H(g)) || I || salt || decimal(A) || decimal(B) || hex(K))
 * Strings are hashed as their UTF-8 text: hex strings are hashed as hex text,
 * big integers as decimal text. A and B travel as minimal lowercase hex.
 */

import { aesGcmSeal, bigIntToBytes, bytesToBigInt, hexToBigInt, randomBytes, sha256 } from './crypto.js';

const N_DECIMAL =
  '4983313092069490398852700692508795473567251422586244806694940877242664573189' +
  '9031929377974469920688180999869580549980123317208691362967809360095087004877' +
  '8996242916151585354155671959334695992953115070645733842905892650581784752485' +
  '5862259333438239756474464759974189984231409170758360686392625635632084395639' +
  '1432298898620415286359069909130872458179594609483453363330867846088230847889' +
  '0668986556662101517542469153571152027378626198985136086866906710110895615953' +
  '0739641990220546209432953829448997561743719584980402874346226230488627145977' +
  '6083898587063918581382006186313852103044299028477021415874705133369054493513' +
  '2712208646472514397031305435865048824116713154469234912338133320451563760865' +
  '6643608393788598011108539679620836313915590459891513992208387515629240292926' +
  '5708943211654826085440301739754527816237918051965463269967905362073591435271' +
  '82077625412731080411108775183565594553871817639221414953634530830290393130518228654795859';

export const SRP_N = BigInt(N_DECIMAL);
export const SRP_G = 2n;
const N_BYTES = Math.ceil(SRP_N.toString(16).length / 2);

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  if (exp < 0n) throw new Error('modPow: negative exponent');
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

const hashInt = (input: Buffer | string): bigint => bytesToBigInt(sha256(input));

export interface SrpProof {
  /** Client proof, hex. Sent as `m1.value`. */
  m1Hex: string;
  /** Session key K (32 bytes). Keys the flowValueProof and encAuth. */
  K: Buffer;
}

export class MitidSrp {
  private readonly a: bigint;
  private readonly A: bigint;
  private K?: Buffer;
  private m1Hex?: string;

  /** `a` is injectable for golden-vector tests only. */
  constructor(a?: bigint) {
    this.a = a ?? bytesToBigInt(randomBytes(32));
    this.A = modPow(SRP_G, this.a, SRP_N);
  }

  /** A as minimal lowercase hex (Python `format(A, 'x')`). Sent as `randomA.value`. */
  get publicAHex(): string {
    return this.A.toString(16);
  }

  /** Derive K and M1 from the server's salt and B. `authSessionId` is the authenticator session id. */
  prove(args: { srpSaltHex: string; randomBHex: string; passwordHex: string; authSessionId: string }): SrpProof {
    const B = hexToBigInt(args.randomBHex);
    if (B % SRP_N === 0n) throw new Error('SRP: server B failed the safety check');

    const x = hashInt(args.srpSaltHex + args.passwordHex);
    const u = hashInt(Buffer.concat([bigIntToBytes(this.A, N_BYTES), bigIntToBytes(B, N_BYTES)])) % SRP_N;
    const k = hashInt(Buffer.concat([Buffer.from(SRP_N.toString(), 'utf8'), bigIntToBytes(SRP_G, N_BYTES)]));
    const S = modPow(B - modPow(SRP_G, x, SRP_N) * k, u * x + this.a, SRP_N);
    const K = sha256(S.toString());

    const xor = hashInt(SRP_N.toString()) ^ hashInt(SRP_G.toString());
    const I = sha256(args.authSessionId).toString('hex');
    const m1Hex = sha256(
      xor.toString() + I + args.srpSaltHex + this.A.toString() + B.toString() + K.toString('hex'),
    ).toString('hex');

    this.K = K;
    this.m1Hex = m1Hex;
    return { m1Hex, K };
  }

  /** Check the server's M2 = SHA256(decimal(A) || decimal(int(M1)) || hex(K)). */
  verifyServer(m2Hex: string): boolean {
    if (!this.K || !this.m1Hex) throw new Error('SRP: verifyServer called before prove');
    const expected = sha256(this.A.toString() + hexToBigInt(this.m1Hex).toString() + this.K.toString('hex'));
    return expected.toString('hex') === m2Hex.toLowerCase();
  }

  /** AES-256-GCM under K, no padding (padding makes MitID answer "Try again"). */
  seal(plaintext: Buffer): Buffer {
    if (!this.K) throw new Error('SRP: seal called before prove');
    return aesGcmSeal(this.K, plaintext);
  }
}
