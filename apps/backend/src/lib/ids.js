// Random, URL-safe identifiers. Clip ids are 12 base62 characters (about 71 bits), short
// enough for a player URL and a Discord message, big enough that guessing one is hopeless.

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Largest multiple of 62 below 256; bytes at or above it are rejected so every character
// is equally likely.
const LIMIT = 248;

/** @param {number} [length] */
export function randomId(length = 12) {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (b < LIMIT) {
        out += ALPHABET[b % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export const newClipId = () => randomId(12);
