/**
 * An update signature, read and checked the way an installed copy checks it.
 *
 * Both halves are minisign, and Tauri wraps each of them in base64 once more:
 * `tauri.conf.json` holds base64 of the public key *file*, and a `.sig` holds
 * base64 of the whole signature *file*. Decoding once gives the minisign text
 * in both cases — comment lines and the payloads between them.
 *
 * Shared by `verify-updater-key.mjs`, which asks whether the key on this
 * machine is the one the application trusts, and `sign-updates.mjs`, which
 * asks the same of every artefact a release signs before it is published.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';

export const unwrap = (text) => Buffer.from(text.trim(), 'base64').toString('utf8');

const lines = (text) => text.split(/\r?\n/).filter(Boolean);
export const payloadLines = (text) =>
  lines(text).filter((line) => !/^(un)?trusted comment:/.test(line));

/**
 * The public key's 42 bytes — `Ed`, the key id, the key — and the id its own
 * comment line names, which minisign prints with the bytes the other way round
 * from the way it stores them.
 */
export function readPublicKey(wrapped) {
  try {
    const text = unwrap(wrapped);
    return {
      bytes: Buffer.from(payloadLines(text)[0] ?? '', 'base64'),
      commentedId: /minisign public key:\s*([0-9A-Fa-f]{16})/.exec(text)?.[1] ?? null,
    };
  } catch {
    return { bytes: Buffer.alloc(0), commentedId: null };
  }
}

export const storedId = (publicKey) =>
  Buffer.from(publicKey.subarray(2, 10)).reverse().toString('hex').toUpperCase();

/**
 * Whether `wrappedSignature` — a `.sig` as Tauri writes it — is a signature of
 * `content` by `publicKey`. Both signatures in it are checked: the one over the
 * file and the global one over that signature and its trusted comment, which
 * is what binds the comment to it.
 *
 * "ED" signs a BLAKE2b-512 hash of the file, "Ed" the file itself. Tauri
 * produces the first; both are read so that a change in its CLI shows up as a
 * failure to verify rather than as the wrong bytes checked in silence.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifySignature(content, wrappedSignature, publicKey) {
  if (publicKey.length !== 42 || publicKey.subarray(0, 2).toString('latin1') !== 'Ed') {
    return { ok: false, reason: 'not an Ed25519 minisign public key' };
  }
  let text;
  try {
    text = unwrap(wrappedSignature);
  } catch {
    return { ok: false, reason: 'not base64' };
  }
  const trusted = lines(text).find((line) => line.startsWith('trusted comment: '));
  const [main, global] = payloadLines(text).map((line) => Buffer.from(line, 'base64'));
  if (!main || main.length !== 74 || !global || global.length !== 64 || !trusted) {
    return { ok: false, reason: 'not a minisign signature' };
  }
  if (!main.subarray(2, 10).equals(publicKey.subarray(2, 10))) {
    return {
      ok: false,
      reason: `signed by key ${storedId(main)}, the application trusts ${storedId(publicKey)}`,
    };
  }

  const algorithm = main.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') {
    return { ok: false, reason: `unknown algorithm ${JSON.stringify(algorithm)}` };
  }
  const signed = algorithm === 'ED' ? createHash('blake2b512').update(content).digest() : content;
  const ed25519 = createPublicKey({
    // SubjectPublicKeyInfo for Ed25519 is a fixed 12-byte prefix and the key.
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.subarray(10)]),
    format: 'der',
    type: 'spki',
  });

  if (!verify(null, signed, ed25519, main.subarray(10))) {
    return { ok: false, reason: 'the signature does not verify over this file' };
  }
  const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf8');
  if (!verify(null, Buffer.concat([main.subarray(10), comment]), ed25519, global)) {
    return { ok: false, reason: 'the global signature does not verify' };
  }
  return { ok: true, reason: algorithm === 'ED' ? 'prehashed, BLAKE2b-512' : 'over the file itself' };
}
