import test from 'node:test';
import assert from 'node:assert/strict';
import { ready, generateIdentity } from '../src/crypto.js';
import { createContact, replaceContactKey, verifyContact, renameContact, validateContacts } from '../src/contacts.js';

await ready();
const first = await generateIdentity(), second = await generateIdentity();
test('contacts begin unverified and require explicit verification', () => {
  const contact = createContact('Алиса', first.publicKey);
  assert.equal(contact.verified, false);
  assert.equal(verifyContact(contact).verified, true);
  assert.equal(contact.verified, false);
});
test('key replacement resets verification, name change preserves it', () => {
  const contact = verifyContact(createContact('Алиса', first.publicKey));
  const changed = replaceContactKey(contact, second.publicKey);
  assert.equal(changed.verified, false); assert.equal(changed.id, contact.id);
  assert.equal(replaceContactKey(contact, first.publicKey).verified, true);
  assert.equal(renameContact(contact, 'Новое имя').verified, true);
});
test('backup contact validation rejects duplicate IDs, malformed data and too many contacts', () => {
  const contact = createContact('Алиса', first.publicKey);
  assert.throws(() => validateContacts([contact, contact]));
  assert.throws(() => validateContacts([{ ...contact, verified: 'true' }]));
  assert.throws(() => validateContacts([{ ...contact, extra: 'field' }]));
  assert.throws(() => createContact(' ', first.publicKey));
  assert.throws(() => createContact('A'.repeat(65), first.publicKey));
  assert.throws(() => createContact('A\nB', first.publicKey));
  assert.throws(() => validateContacts(Array(101).fill(contact)));
});
