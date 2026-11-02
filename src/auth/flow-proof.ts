/**
 * MitID `flowValueProof`: an HMAC proving the client holds both the SRP key K
 * and the flow context the server bound into the session. Every authenticator
 * sends it hex-encoded; only the key prefix differs (APP and PASSWORD use
 * `flowValues`, the code token uses `OTP` + the six digits).
 */

import { hmacSha256, sha256 } from './crypto.js';

export interface FlowContext {
  authenticatorSessionId: string;
  authenticatorSessionFlowKey: string;
  /** Hex of the base64-decoded `aux.coreClient.checksum`. */
  clientHash: string;
  eafeHash: string;
  brokerSecurityContext: string;
  referenceTextHeader: string;
  referenceTextBody: string;
  serviceProviderName: string;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export function flowProofMessage(ctx: FlowContext): string {
  return [
    ctx.authenticatorSessionId,
    ctx.authenticatorSessionFlowKey,
    ctx.clientHash,
    ctx.eafeHash,
    sha256(ctx.brokerSecurityContext).toString('hex'),
    b64(ctx.referenceTextHeader),
    b64(ctx.referenceTextBody),
    b64(ctx.serviceProviderName),
  ].join(',');
}

export function signFlowProof(message: string, K: Buffer, prefix: string): string {
  const key = sha256(prefix + K.toString('hex'));
  return hmacSha256(key, message).toString('hex');
}
