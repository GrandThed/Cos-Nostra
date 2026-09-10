// Device tokens and login codes. A device token is shown to the desktop app exactly once
// and only its SHA-256 is stored, so a database leak does not hand out working tokens.

import { createHash, randomBytes, randomInt } from 'node:crypto';

/** @returns {string} 32 random bytes as base64url */
export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** @returns {string} hex SHA-256 of the token, what `devices.token_hash` stores */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// No 0/O/1/I so a code read off a screen cannot be mistyped.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @returns {string} 8 character login code, e.g. "K7QZ3MPW" */
export function newLoginCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
