import { ready, generateIdentity, exportPublicKey, importPublicKey, fingerprint, encryptContent, decryptContent, exportBackup, importBackup, splitContainer, assembleContainer, wipe } from './crypto.js';
import { createContact, replaceContactKey, verifyContact } from './contacts.js';

let identity = null;
let running = false;
const info = () => ({ publicKey: exportPublicKey(identity.publicKey), fingerprint: fingerprint(identity.publicKey) });
const requireIdentity = () => { if (!identity) throw new Error('Ключи заблокированы.'); };
const contactFields = ({ id, name, publicKey, verified }) => ({ id, name, publicKey, verified });
self.onmessage = async ({ data: { id, action, args = {} } }) => {
  if (running) { self.postMessage({ id, error: 'Дождитесь текущей операции.' }); return; }
  running = true;
  try {
    await ready();
    let result;
    const progress = value => self.postMessage({ id, progress: value });
    switch (action) {
      case 'ready': result = true; break;
      case 'generate':
        if (identity) wipe(identity.secretKey);
        identity = await generateIdentity(); result = info(); break;
      case 'restore': {
        const restored = await importBackup(args.text, args.password);
        if (identity) wipe(identity.secretKey);
        identity = restored.identity;
        result = { ...info(), contacts: restored.contacts }; break;
      }
      case 'backup': requireIdentity(); result = await exportBackup(identity, args.contacts, args.password); break;
      case 'contact': result = createContact(args.name, importPublicKey(args.key)); break;
      case 'replace': result = replaceContactKey(contactFields(args.contact), importPublicKey(args.key)); break;
      case 'verify': result = verifyContact(contactFields(args.contact)); break;
      case 'fingerprint': result = fingerprint(importPublicKey(args.key)); break;
      case 'encrypt':
        requireIdentity();
        try { result = await encryptContent(args.content, identity, importPublicKey(args.key), progress); }
        finally { wipe(args.content.data); }
        break;
      case 'decrypt': requireIdentity(); result = await decryptContent(assembleContainer(args.text), identity, importPublicKey(args.key), progress); break;
      case 'split': result = splitContainer(args.text, 4000); break;
      default: throw new Error('Неизвестная операция.');
    }
    if (result?.data instanceof Uint8Array) self.postMessage({ id, result }, [result.data.buffer]);
    else self.postMessage({ id, result });
  } catch {
    self.postMessage({ id, error: 'Операция не выполнена. Проверьте формат, лимиты, пароль и выбранные ключи. Повреждённые или неподходящие данные отклонены.' });
  } finally {
    if (args.password) args.password = '';
    running = false;
  }
};
