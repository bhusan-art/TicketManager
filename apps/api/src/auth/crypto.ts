import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations).
// algorithm 2 = Argon2id (the package's Algorithm enum is a const enum, unusable with isolatedModules).
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string) {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string) {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verifying against a dummy hash when the user doesn't exist keeps response times similar,
// so login timing doesn't reveal which emails have accounts.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string) {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** A random, URL-safe token for links and refresh cookies. */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** Only hashes of tokens are stored, so a database leak doesn't expose usable tokens. */
export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
