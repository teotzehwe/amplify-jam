import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, publicUser, verifyPassword } from '../src/passwords.js';

test('hashPassword produces a verifiable scrypt hash', () => {
  const { salt, hash } = hashPassword('jam-night-1');
  assert.equal(typeof salt, 'string');
  assert.equal(typeof hash, 'string');
  assert.ok(salt.length >= 16);
  assert.ok(hash.length >= 32);
  assert.equal(verifyPassword('jam-night-1', salt, hash), true);
  assert.equal(verifyPassword('wrong', salt, hash), false);
});

test('publicUser strips credential fields', () => {
  const safe = publicUser({
    id: 'usr1',
    username: 'alex',
    displayName: 'Alex',
    passwordHash: 'secret',
    passwordSalt: 'salt',
    disabled: false,
  });
  assert.equal(safe.passwordHash, undefined);
  assert.equal(safe.passwordSalt, undefined);
  assert.equal(safe.username, 'alex');
});
