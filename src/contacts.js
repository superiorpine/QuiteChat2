import sodium from 'libsodium-wrappers-sumo';
import { exportPublicKey, importPublicKey } from './crypto.js';
import { LIMITS } from './limits.js';

function cleanName(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > LIMITS.contactName || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Имя контакта: от 1 до 64 символов, без управляющих символов.');
  return value.trim();
}
function publicText(key) { return exportPublicKey(typeof key === 'string' ? importPublicKey(key) : key); }
export function createContact(name, publicKey) {
  return { id: sodium.to_base64(sodium.randombytes_buf(16), sodium.base64_variants.URLSAFE_NO_PADDING), name: cleanName(name), publicKey: publicText(publicKey), verified: false };
}
export function replaceContactKey(contact, publicKey) {
  const key = publicText(publicKey);
  return { ...validateContacts([contact])[0], publicKey: key, verified: key === contact.publicKey ? contact.verified : false };
}
export function verifyContact(contact) { return { ...validateContacts([contact])[0], verified: true }; }
export function renameContact(contact, name) { return { ...validateContacts([contact])[0], name: cleanName(name) }; }
export function validateContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length > LIMITS.contacts) throw new Error('Допустимо не более 100 контактов.');
  const ids = new Set();
  return contacts.map(contact => {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact) || Object.keys(contact).sort().join(',') !== 'id,name,publicKey,verified' || typeof contact.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(contact.id) || typeof contact.verified !== 'boolean' || ids.has(contact.id)) throw new Error('Неверная структура контактов.');
    ids.add(contact.id);
    return { id: contact.id, name: cleanName(contact.name), publicKey: publicText(contact.publicKey), verified: contact.verified };
  });
}
