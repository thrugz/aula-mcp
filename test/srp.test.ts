import { describe, expect, it } from 'vitest';
import { aesGcmOpen } from '../src/auth/crypto.js';
import { flowProofMessage, signFlowProof } from '../src/auth/flow-proof.js';
import { MitidSrp, modPow, SRP_G, SRP_N } from '../src/auth/srp.js';

// Golden vectors produced by the Python reference (scaarup/aula CustomSRP.py)
// with a pinned `a`, as published in Casperjuel/aula-mcp's srp.test.ts.
const V = {
  a: BigInt(`0x${'aa'.repeat(32)}`),
  A: '12a4c4852c2b41cd9e3e456df7b79ba4e8296b35afd9614da9784c0af98776bb229da72acf6f7c3ccce1332aaed44d68aa0013ce76046dc581b039923f318c877fd63654e25539d507000b568d51fa25944179fa920ba96754464d9c05208ec76b6bacdc5a512fdfe4f661f5ccf99a985894ec819a9222732cbd9cf43cf47ba18eef4240664cf17990b6313127cff4ffe0cf14f66aa1eab329244cc17a809f367408838e5a76960204041d9bc54a748b2a5a64692b9724efd1d4612b6cd502ac03c7971e41d647aa40b6136246f757b70af88df1d175b1036999351356e90fd0c658ada9d0fdc6fa45c8e154b0e71e52b7e02f113b3ff4350fcc1bdcd004b6ab5c46191e410ae2e056111f090c6523e3fefe96b48dbfee766cf66c90af58c77999d23eaf49b55356af2a7825d2a3767f510d6eac16f05db843a8047000fb6cd71fda8d88687f20a0b5feadb975286545dd1707a56f6e0cbe487f8a07ce724c98c10b626335ca15d6a2bf33e05927ae68409508102b07575a31391f0a2f01e213',
  salt: 'ab'.repeat(32),
  B: '132e1c7aa9d0b2f2946123eba34836865d2f25cf2f22318ac55865fa3c910cb4f27678fa72f49da0',
  password: 'cd'.repeat(32),
  asid: 'test-session-uuid-12345',
  M1: 'b17f22a30c3bf99168221d10f18f5c6b7d858c63f4bb85beecc80155ed013343',
  K: 'b092dc185d90bd046d8e8a8314acddcea332af32a6abb662e9f8ca92d47d1046',
  M2: 'c8906d7dc6fcda339cc47d73f4626292a0a6dc819cafa261e311e733f3faa570',
};

function proved() {
  const srp = new MitidSrp(V.a);
  const proof = srp.prove({ srpSaltHex: V.salt, randomBHex: V.B, passwordHex: V.password, authSessionId: V.asid });
  return { srp, proof };
}

describe('MitID SRP', () => {
  it('uses the 3072-bit MitID prime and g = 2', () => {
    expect(SRP_N.toString(2)).toHaveLength(3072);
    expect(SRP_N.toString(16).startsWith('db96e5d0bcad')).toBe(true);
    expect(SRP_G).toBe(2n);
  });

  it('modPow normalises negative bases', () => {
    expect(modPow(7n, 3n, 1000n)).toBe(343n);
    expect(modPow(-3n, 1n, 11n)).toBe(8n);
    expect(modPow(5n, 5n, 1n)).toBe(0n);
  });

  it('derives A for a pinned a', () => {
    expect(new MitidSrp(V.a).publicAHex).toBe(V.A);
  });

  it('derives M1 and K matching the Python reference', () => {
    const { proof } = proved();
    expect(proof.m1Hex).toBe(V.M1);
    expect(proof.K.toString('hex')).toBe(V.K);
  });

  it('accepts the matching server M2 and rejects others', () => {
    const { srp } = proved();
    expect(srp.verifyServer(V.M2)).toBe(true);
    expect(srp.verifyServer('00'.repeat(32))).toBe(false);
  });

  it('rejects B = 0 and B = N', () => {
    const srp = new MitidSrp(V.a);
    const args = { srpSaltHex: V.salt, passwordHex: V.password, authSessionId: V.asid };
    expect(() => srp.prove({ ...args, randomBHex: '00' })).toThrow();
    expect(() => srp.prove({ ...args, randomBHex: SRP_N.toString(16) })).toThrow();
  });

  it('seals with K as iv(16) || ciphertext || tag(16), unpadded', () => {
    const { srp, proof } = proved();
    const plain = Buffer.from('signature bytes');
    const sealed = srp.seal(plain);
    expect(sealed.length).toBe(16 + plain.length + 16);
    expect(aesGcmOpen(proof.K, sealed).toString()).toBe('signature bytes');
  });
});

describe('flowValueProof', () => {
  const K = Buffer.alloc(32, 0x11);

  // Vectors from Casperjuel/aula-mcp mitid-flow-proof.test.ts (HMAC over "msg").
  it('signs with prefix + hex(K) as the hashed HMAC key', () => {
    expect(signFlowProof('msg', K, 'OTP123456')).toBe(
      '17a8239ce89070cc37816cf7af3197fbd0ad0ef4fa742932954a500f30e18e39',
    );
    expect(signFlowProof('msg', K, 'flowValues')).toBe(
      '841b7289b549099c2b0ee29b65e2dc6fcf4e5ba5615e9be3653f3ce5b96c7389',
    );
  });

  it('joins the eight fields in wire order', () => {
    const parts = flowProofMessage({
      authenticatorSessionId: 'sess',
      authenticatorSessionFlowKey: 'flow',
      clientHash: 'deadbeef',
      eafeHash: 'eafe',
      brokerSecurityContext: 'broker-ctx',
      referenceTextHeader: 'Header tekst',
      referenceTextBody: 'Body tekst',
      serviceProviderName: 'Aula',
    }).split(',');
    expect(parts).toHaveLength(8);
    expect(parts.slice(0, 4)).toEqual(['sess', 'flow', 'deadbeef', 'eafe']);
    expect(parts[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(parts.slice(5)).toEqual(
      ['Header tekst', 'Body tekst', 'Aula'].map((s) => Buffer.from(s).toString('base64')),
    );
  });
});
