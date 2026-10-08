import './styles.css';
import { prepareImage, prepareAudio, validateMedia, createRecorder } from './media.js';

const $ = id => document.getElementById(id);
const VAULT_KEY = 'quietchat.vault.v1';
const MAX_CONTAINER = 14 * 1024 * 1024;
let worker, nextId = 0, epoch = 0, unlocked = false, contacts = [], kind = 'text';
let runtimeReady = false;
let prepared = null, decrypted = null, ciphertext = '', parts = '', recorder = null, operation = null, pendingBackup = '';
let lastActivity = Date.now();
const requests = new Map(), urls = new Set();
const sizeLabel = n => n < 1024 ? `${n} Б` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} КиБ` : `${(n / 1024 ** 2).toFixed(2)} МиБ`;
const show = (id, visible = true) => { $(id).hidden = !visible; };
const wipe = content => { content?.data?.fill(0); };
function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); show('notice'); }
function spawnWorker() {
  worker = new Worker(new URL('./crypto-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const pending = requests.get(data.id);
    if (!pending) { data.result?.data?.fill(0); return; }
    if ('progress' in data) {
      const n = typeof data.progress === 'number' ? data.progress : data.progress?.percent;
      if (Number.isFinite(n)) $('busy-progress').value = n <= 1 ? n * 100 : n;
      return;
    }
    requests.delete(data.id);
    data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
  };
  worker.onerror = event => { event.preventDefault(); lock(false); notify('Криптографический модуль остановлен. Перезагрузите приложение; проверьте поддержку WebAssembly.', true); };
}
function rpc(action, args = {}) {
  if (!worker) spawnWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker.postMessage({ id, action, args }); });
}
async function run(title, action) {
  if (operation) { notify('Дождитесь завершения или отмените текущую операцию.', true); return; }
  const startEpoch = epoch;
  lastActivity = Date.now();
  const controller = new AbortController(); operation = controller;
  $('busy-title').textContent = title; $('busy-progress').removeAttribute('value'); show('busy-panel');
  try { await action(controller.signal, () => startEpoch === epoch && !controller.signal.aborted); }
  catch (error) { if (epoch === startEpoch && error.name !== 'AbortError') notify(error.message || 'Операция не выполнена.', true); }
  finally { if (epoch === startEpoch) { operation = null; show('busy-panel', false); } }
}
function page(name) {
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== `page-${name}`; });
  document.querySelectorAll('[data-page]').forEach(node => { node.classList.toggle('active', node.dataset.page === name); });
  show('notice', false);
}
function mustUnlock() {
  if (unlocked) return true;
  page('keys'); notify('Создайте ключи или восстановите зашифрованную копию. Перед блокировкой обязательно сохраните резервную копию.', true); return false;
}
function mustBeReady() {
  if (runtimeReady) return true;
  notify('Дождитесь подтверждённой подготовки офлайн. Если версия изменилась, закройте все вкладки QuietChat и откройте приложение заново.', true);
  return false;
}
function releaseUrls() { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
function clearViewer(id) {
  const viewer = $(id);
  viewer.querySelectorAll('audio').forEach(audio => { audio.pause(); const url = audio.getAttribute('src'); if (urls.has(url)) { URL.revokeObjectURL(url); urls.delete(url); } audio.removeAttribute('src'); audio.load(); });
  viewer.querySelectorAll('[src]').forEach(node => { const url = node.getAttribute('src'); if (urls.has(url)) { URL.revokeObjectURL(url); urls.delete(url); } });
  viewer.replaceChildren();
}
function clearPrepared() { wipe(prepared); prepared = null; clearViewer('prepared-preview'); show('prepared-preview', false); show('remove-media', false); $('media-file').value = ''; }
function clearDecrypted() { wipe(decrypted); decrypted = null; clearViewer('decrypted-view'); show('decrypted-result', false); }
function lock(announce = true) {
  ++epoch;
  operation?.abort(); operation = null;
  recorder?.cancel(); recorder = null;
  worker?.terminate(); worker = null;
  for (const pending of requests.values()) pending.reject(new DOMException('Отменено', 'AbortError'));
  requests.clear();
  clearPrepared(); clearDecrypted(); releaseUrls();
  contacts = []; unlocked = false; ciphertext = ''; parts = ''; pendingBackup = '';
  document.querySelectorAll('.sensitive, input[type=file]').forEach(node => { node.value = ''; });
  $('my-fingerprint').textContent = '';
  $('identity-state').textContent = 'Ключи не созданы или заблокированы.';
  $('key-status').textContent = 'Ключи заблокированы';
  $('key-status').classList.remove('unlocked');
  $('generate-key').disabled = false;
  for (const id of ['identity-info', 'cipher-result', 'parts-output', 'parts-actions', 'busy-panel', 'record-stop', 'backup-import']) show(id, false);
  show('record-start'); $('record-status').textContent = ''; $('original-media').checked = false;
  renderContacts(); updateCounter();
  if (announce) notify('Заблокировано. Ключи и содержимое текущего сеанса очищены по возможности. Для восстановления нужна зашифрованная копия.');
}
function setIdentity(info) {
  unlocked = true;
  $('my-public').value = info.publicKey; $('my-fingerprint').textContent = info.fingerprint;
  $('identity-state').textContent = 'Ключи разблокированы только в этом сеансе.';
  $('key-status').textContent = 'Ключи разблокированы'; $('key-status').classList.add('unlocked');
  $('generate-key').disabled = true; show('identity-info');
  if (info.contacts) contacts = info.contacts;
  renderContacts();
}
function renderContacts() {
  $('contact-count').textContent = String(contacts.length);
  for (const id of ['recipient', 'sender']) {
    const selected = $(id).value; $(id).replaceChildren(new Option('Выберите проверенный контакт', ''));
    contacts.filter(contact => contact.verified).forEach(contact => $(id).add(new Option(contact.name, contact.id)));
    if (contacts.some(contact => contact.id === selected && contact.verified)) $(id).value = selected;
  }
  $('contacts-list').replaceChildren(); show('contacts-empty', contacts.length === 0);
  contacts.forEach(contact => {
    const card = document.createElement('article'); card.className = 'card contact-card';
    const header = document.createElement('div'); header.className = 'card-title';
    const name = document.createElement('h3'); name.textContent = contact.name;
    const tag = document.createElement('span'); tag.className = contact.verified ? 'tag verified' : 'tag'; tag.textContent = contact.verified ? 'Проверен' : 'Не проверен';
    header.append(name, tag); card.append(header);
    const fp = document.createElement('output'); fp.className = 'fingerprint'; fp.textContent = contact.fingerprint || '…'; card.append(fp);
    if (!contact.fingerprint) {
      const renderEpoch = epoch;
      // Fingerprints are computed sequentially by callers; restored contacts refresh in refreshFingerprints.
      fp.dataset.contactId = contact.id;
      if (renderEpoch !== epoch) return;
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    if (!contact.verified) {
      const verify = document.createElement('button'); verify.className = 'button secondary'; verify.textContent = 'Я сверил полный отпечаток';
      verify.onclick = () => run('Подтверждение контакта…', async (_, current) => {
        const result = await rpc('verify', { contact });
        if (!current()) return; result.fingerprint = contact.fingerprint;
        contacts = contacts.map(c => c.id === contact.id ? result : c); renderContacts(); notify('Контакт проверен. Если используете локальное хранилище, сохраните его заново.');
      }); actions.append(verify);
    }
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Заменить ключ'; details.append(summary);
    const warning = document.createElement('p'); warning.textContent = 'Новый ключ сбросит проверку. Сначала выясните причину замены по независимому каналу.'; details.append(warning);
    const input = document.createElement('textarea'); input.className = 'code sensitive'; input.placeholder = 'Новый QCP1…'; input.maxLength = 256; input.spellcheck = false; input.autocomplete = 'off'; input.setAttribute('aria-label', `Новый ключ: ${contact.name}`); details.append(input);
    const replace = document.createElement('button'); replace.className = 'button secondary'; replace.textContent = 'Заменить и сбросить проверку';
    replace.onclick = () => run('Проверка нового ключа…', async (_, current) => {
      const result = await rpc('replace', { contact, key: input.value });
      result.fingerprint = await rpc('fingerprint', { key: result.publicKey });
      if (!current()) return;
      contacts = contacts.map(c => c.id === contact.id ? result : c); renderContacts(); notify('Ключ заменён. Сверьте новый отпечаток и подтвердите его.');
    }); details.append(replace);
    const remove = document.createElement('button'); remove.className = 'button ghost'; remove.textContent = 'Удалить'; remove.onclick = () => { contacts = contacts.filter(c => c.id !== contact.id); renderContacts(); notify('Контакт удалён из памяти. Сохранённая копия хранилища обновляется отдельно.'); }; actions.append(remove);
    card.append(actions, details); $('contacts-list').append(card);
  });
}
async function refreshFingerprints(current) {
  for (const contact of contacts) { const fp = await rpc('fingerprint', { key: contact.publicKey }); if (!current()) return; contact.fingerprint = fp; }
  renderContacts();
}
const storedContacts = () => contacts.map(({ id, name, publicKey, verified }) => ({ id, name, publicKey, verified }));
function chosenContact(id) { const contact = contacts.find(c => c.id === $(id).value && c.verified); if (!contact) throw new Error('Выберите контакт и подтвердите проверку его полного отпечатка.'); return contact; }
function preview(content, target) {
  clearViewer(target);
  if (content.kind === 'text') { const text = document.createElement('pre'); text.className = 'plain-result'; text.textContent = new TextDecoder('utf-8', { fatal: true }).decode(content.data); $(target).append(text); return; }
  validateMedia(content.data, content.kind, content.mime);
  const url = URL.createObjectURL(new Blob([content.data], { type: content.mime })); urls.add(url);
  const node = document.createElement(content.kind === 'image' ? 'img' : 'audio');
  if (content.kind === 'image') node.alt = 'Локальная версия изображения';
  else {
    node.controls = true; node.preload = 'metadata';
    if (!node.canPlayType(content.mime)) notify('Этот браузер не подтверждает воспроизведение формата. Попросите отправителя подготовить приватную WAV-копию.', true);
    node.onerror = () => notify('Браузер не смог воспроизвести аудио. Попросите приватную WAV-копию или проверьте файл локально.', true);
  }
  node.src = url; $(target).append(node);
  if (content.kind === 'audio') { const note = document.createElement('p'); note.className = 'field-hint'; note.textContent = 'Если браузер не воспроизводит оригинальный формат, попросите отправителя создать приватную WAV-копию.'; $(target).append(note); }
}
function download(data, mime, name) {
  const url = URL.createObjectURL(new Blob([data], { type: mime })); urls.add(url);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 15000);
}
async function copy(text) { if (!navigator.clipboard?.writeText) throw new Error('Буфер обмена недоступен. Выделите текст вручную или сохраните файл.'); await navigator.clipboard.writeText(text); notify('Скопировано по вашему нажатию. Буфер обмена может синхронизироваться с другими устройствами.'); }
function fileText(file, max) { if (!file || file.size > max) throw new Error('Файл отсутствует или превышает допустимый размер.'); return file.text(); }
function passwords(confirm) {
  const password = $('backup-password').value, repeated = $('backup-confirm').value;
  $('backup-password').value = ''; $('backup-confirm').value = '';
  if (password.length < 12 || password.length > 1024) throw new Error('Введите парольную фразу от 12 до 1024 символов.');
  if (confirm && password !== repeated) throw new Error('Повтор парольной фразы не совпадает.');
  return password;
}
function vaultStatus() { try { $('vault-status').textContent = localStorage.getItem(VAULT_KEY) ? 'На устройстве есть зашифрованная копия.' : 'Постоянное хранение выключено: локальной копии нет.'; } catch { $('vault-status').textContent = 'Браузер запретил постоянное хранилище.'; } }
function setKind(next) {
  recorder?.cancel(); recorder = null; clearPrepared(); kind = next; $('original-media').checked = false;
  document.querySelectorAll('[data-kind]').forEach(node => node.classList.toggle('selected', node.dataset.kind === kind));
  show('text-composer', kind === 'text'); show('media-composer', kind !== 'text'); show('recording-controls', kind === 'audio'); show('paste-image', kind === 'image');
  $('media-file').accept = kind === 'image' ? 'image/png,image/jpeg,image/webp' : 'audio/wav,audio/mpeg,audio/ogg,audio/webm,audio/mp4,.wav,.mp3,.ogg,.webm,.m4a';
  $('media-title').textContent = kind === 'image' ? 'Ваша фотография — только здесь' : 'Голос, который услышит собеседник';
  $('media-symbol').textContent = kind === 'image' ? '▧' : '◉';
  $('media-formats').textContent = kind === 'image' ? 'PNG, JPEG, WebP · до 8 МиБ и 12 Мп' : 'До 60 секунд и 8 МиБ · приватная копия в WAV';
  $('media-warning').textContent = kind === 'image' ? 'По умолчанию создаётся приватная копия из пикселей. Оригинал может содержать EXIF, GPS и другие метаданные. Качество, цвет, ориентация и анимация могут измениться.' : 'По умолчанию звук локально декодируется в PCM WAV без имени, обложки и тегов. WAV увеличивает размер. Оригинал может содержать метаданные и не воспроизводиться у собеседника.';
}
function updateCounter() { $('text-counter').textContent = `${sizeLabel(new TextEncoder().encode($('plain-text').value).length)} / 64 КиБ`; }
async function prepare(file) {
  if (!file) return;
  if (!mustUnlock()) return;
  await run('Подготовка приватного вложения…', async (signal, current) => {
    clearPrepared();
    const output = await (kind === 'image' ? prepareImage : prepareAudio)(file, { original: $('original-media').checked, signal, onProgress: value => { if (typeof value === 'number') $('busy-progress').value = value <= 1 ? value * 100 : value; } });
    if (!current()) { wipe(output); return; }
    try { preview(output, 'prepared-preview'); } catch (error) { wipe(output); throw error; }
    prepared = output; show('prepared-preview'); show('remove-media');
    notify(`Подготовлено ${sizeLabel(output.data.length)}. Предпросмотр показывает именно содержимое для шифрования.`);
  });
}

document.querySelectorAll('[data-page]').forEach(node => node.onclick = () => page(node.dataset.page));
document.querySelectorAll('[data-go]').forEach(node => node.onclick = () => page(node.dataset.go));
document.querySelector('.brand').onclick = event => { event.preventDefault(); page('encrypt'); };
document.querySelectorAll('[data-kind]').forEach(node => node.onclick = () => { if (operation) return; setKind(node.dataset.kind); });
$('lock').onclick = () => lock(); $('cancel-operation').onclick = () => lock();
$('plain-text').oninput = updateCounter;
$('generate-key').onclick = () => { if (!mustBeReady()) return; run('Создание ключей на устройстве…', async (_, current) => { const info = await rpc('generate'); if (!current()) return; setIdentity(info); notify('Ключи созданы. Сохраните зашифрованную резервную копию сейчас: блокировка удаляет несохранённые ключи.'); }); };
$('copy-public').onclick = () => run('Копирование…', () => copy($('my-public').value));
$('save-public').onclick = () => download($('my-public').value, 'text/plain', 'quietchat-public.txt');
for (const id of ['backup-export', 'vault-save']) $(id).onclick = () => {
  if (!mustUnlock()) return;
  run('Шифрование резервной копии · Argon2id…', async (_, current) => {
    const password = passwords(true); const backup = await rpc('backup', { contacts: storedContacts(), password });
    if (!current()) return;
    if (id === 'vault-save') { localStorage.setItem(VAULT_KEY, backup); vaultStatus(); notify('Ключи и контакты сохранены локально в зашифрованном виде. Пароль не сохранён.'); }
    else { download(backup, 'text/plain', 'quietchat-backup.qcb'); notify('Зашифрованная резервная копия подготовлена к сохранению. Храните пароль отдельно.'); }
  });
};
async function restore(text) {
  if (!mustBeReady()) return;
  const password = passwords(false);
  if (unlocked) throw new Error('Сначала заблокируйте текущий профиль, сохранив резервную копию.');
  await run('Восстановление ключей · Argon2id…', async (_, current) => {
    const info = await rpc('restore', { text, password });
    if (!current()) return; setIdentity(info); await refreshFingerprints(current); if (current()) notify('Ключи и контакты восстановлены.');
  });
}
$('backup-file').onchange = async event => { try { const file = event.target.files[0]; event.target.value = ''; if (file) { pendingBackup = await fileText(file, 256 * 1024); show('backup-import'); notify('Зашифрованная копия прочитана. Введите парольную фразу и нажмите «Восстановить выбранную копию».'); } } catch (error) { notify(error.message, true); } };
$('backup-import').onclick = async () => { try { await restore(pendingBackup); if (unlocked) { pendingBackup = ''; show('backup-import', false); } } catch (error) { notify(error.message, true); } };
$('vault-unlock').onclick = async () => { try { const text = localStorage.getItem(VAULT_KEY); if (!text) throw new Error('Локальная копия не найдена.'); await restore(text); } catch (error) { notify(error.message, true); } };
$('vault-delete').onclick = () => { try { localStorage.removeItem(VAULT_KEY); vaultStatus(); notify('Зашифрованная локальная копия удалена. Уже экспортированные файлы остаются у вас.'); } catch { notify('Хранилище недоступно.', true); } };
$('contact-file').onchange = async event => { const importEpoch = epoch; try { const file = event.target.files[0]; event.target.value = ''; if (file) { const text = await fileText(file, 1024); if (epoch === importEpoch) $('contact-key').value = text; } } catch (error) { if (epoch === importEpoch) notify(error.message, true); } };
$('contact-add').onclick = () => {
  if (!mustUnlock()) return;
  run('Проверка открытого ключа…', async (_, current) => {
    if (contacts.length >= 100) throw new Error('Максимум 100 контактов.');
    const contact = await rpc('contact', { name: $('contact-name').value.trim(), key: $('contact-key').value });
    contact.fingerprint = await rpc('fingerprint', { key: contact.publicKey });
    if (!current()) return; contacts.push(contact); $('contact-name').value = ''; $('contact-key').value = ''; renderContacts(); notify('Контакт добавлен. Сверьте полный отпечаток и подтвердите проверку.');
  });
};
$('media-file').onchange = event => prepare(event.target.files[0]);
$('original-media').onchange = () => { clearPrepared(); notify($('original-media').checked ? 'Оригинал сохраняет метаданные. Выберите файл заново, если осознанно хотите передать его без очистки.' : 'Приватная копия включена. Выберите файл заново.'); };
$('paste-image').onclick = () => run('Чтение изображения из буфера…', async (signal, current) => {
  if (!mustUnlock()) return;
  if (!navigator.clipboard?.read) throw new Error('Этот браузер не поддерживает чтение картинки из буфера. Используйте выбор файла.');
  const items = await navigator.clipboard.read();
  const item = items.find(item => item.types.some(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type)));
  if (!item) throw new Error('В буфере нет поддерживаемого растрового изображения.');
  const type = item.types.find(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
  const file = await item.getType(type);
  if (!current()) return; clearPrepared();
  const output = await prepareImage(file, { original: $('original-media').checked, signal });
  if (!current()) { wipe(output); return; } preview(output, 'prepared-preview'); prepared = output; show('prepared-preview'); show('remove-media');
});
$('remove-media').onclick = () => { recorder?.cancel(); clearPrepared(); };
$('record-start').onclick = async () => {
  if (!mustUnlock() || operation) return;
  const recordingEpoch = epoch; clearPrepared();
  recorder?.cancel();
  recorder = createRecorder({
    onState(state) { if (recordingEpoch !== epoch) return; show('record-stop', state === 'recording'); show('record-start', state === 'idle'); $('record-status').textContent = state === 'recording' ? '● Идёт запись · максимум 60 секунд' : state === 'processing' ? 'Подготовка WAV…' : ''; },
    onReady(output) { if (recordingEpoch !== epoch) { wipe(output); return; } try { clearPrepared(); preview(output, 'prepared-preview'); prepared = output; show('prepared-preview'); show('remove-media'); notify('Запись готова: PCM WAV без тегов. Прослушайте её перед шифрованием.'); } catch (error) { wipe(output); notify(error.message, true); } },
    onError(error) { if (recordingEpoch === epoch) notify(error.message || 'Не удалось записать звук.', true); }
  });
  try { await recorder.start(); } catch (error) { if (recordingEpoch === epoch) notify(error.message, true); }
};
$('record-stop').onclick = () => recorder?.stop();
$('encrypt').onclick = () => {
  if (!mustUnlock()) return;
  run('Шифрование и проверка контейнера…', async (_, current) => {
    const contact = chosenContact('recipient');
    const content = kind === 'text' ? { kind: 'text', mime: 'text/plain;charset=utf-8', data: new TextEncoder().encode($('plain-text').value) } : prepared;
    if (!content) throw new Error('Добавьте вложение или завершите запись.');
    if (content.data.length === 0) throw new Error('Введите текст или добавьте вложение.');
    let output;
    try { output = await rpc('encrypt', { content, key: contact.publicKey }); } finally { if (kind === 'text') wipe(content); }
    if (!current()) return;
    ciphertext = output; parts = ''; $('parts-output').value = ''; show('parts-output', false); show('parts-actions', false);
    renderCipher(); $('cipher-size').textContent = sizeLabel(output.length); show('cipher-result'); notify('Зашифровано локально. Теперь вы можете передать контейнер получателю.');
  });
};
function renderCipher() {
  if ($('group-cipher').checked && ciphertext.length > 65536) { $('group-cipher').checked = false; notify('Группировка доступна для коротких контейнеров до 64 КиБ. Для медиа используйте файл или части.'); }
  $('cipher-output').value = $('group-cipher').checked ? 'QC1.\n' + ciphertext.slice(4).replace(/(.{5})(?=.)/g, '$1 ') : ciphertext;
}
$('group-cipher').onchange = renderCipher;
$('copy-cipher').onclick = () => run('Копирование…', () => copy($('cipher-output').value));
$('save-cipher').onclick = () => download($('cipher-output').value, 'text/plain', 'quietchat-message.txt');
$('split-cipher').onclick = () => run('Разделение на части…', async (_, current) => { const result = await rpc('split', { text: ciphertext }); if (!current()) return; parts = result.join('\n\n'); $('parts-output').value = parts; show('parts-output'); show('parts-actions'); notify(`Создано частей: ${result.length}. Передайте все части одного набора.`); });
$('copy-parts').onclick = () => run('Копирование…', () => copy(parts));
$('save-parts').onclick = () => download(parts, 'text/plain', 'quietchat-parts.txt');
$('cipher-file').onchange = async event => { const importEpoch = epoch; try { const file = event.target.files[0]; event.target.value = ''; if (!file) return; const text = await fileText(file, MAX_CONTAINER); if (importEpoch === epoch) $('cipher-input').value = text; } catch (error) { notify(error.message, true); } };
$('decrypt').onclick = () => {
  if (!mustUnlock()) return;
  clearDecrypted();
  run('Проверка всех блоков и расшифровка…', async (_, current) => {
    const contact = chosenContact('sender'); const text = $('cipher-input').value;
    if (text.length > MAX_CONTAINER) throw new Error('Слишком большой контейнер.');
    const output = await rpc('decrypt', { text, key: contact.publicKey });
    if (!current()) { wipe(output); return; }
    try { preview(output, 'decrypted-view'); } catch (error) { wipe(output); throw error; }
    decrypted = output; show('decrypted-result'); show('copy-plain', output.kind === 'text'); notify('Целостность всего контейнера и ключи проверены. Содержимое доступно только в этом сеансе.');
  });
};
$('copy-plain').onclick = () => run('Копирование…', () => copy(new TextDecoder().decode(decrypted.data)));
$('save-plain').onclick = () => { if (!decrypted) return; const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a' }; download(decrypted.data, decrypted.mime, 'quietchat-content.' + (extensions[decrypted.mime] || 'txt')); };
$('clear-plain').onclick = clearDecrypted;

for (const event of ['pointerdown', 'keydown', 'input']) document.addEventListener(event, () => { lastActivity = Date.now(); }, { passive: true });
setInterval(() => { if (unlocked && Date.now() - lastActivity >= 5 * 60 * 1000) lock(); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.hidden) { show('privacy-curtain'); lock(false); } else { show('privacy-curtain', false); lastActivity = Date.now(); } });
window.addEventListener('pagehide', () => lock(false));
window.addEventListener('pageshow', () => { if (!document.hidden) show('privacy-curtain', false); });
$('build-version').textContent = `Сборка ${__BUILD_VERSION__}`;
vaultStatus(); renderContacts();

async function offlineReady() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { $('offline-status').textContent = 'Офлайн недоступен'; return; }
  try {
    const registration = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).href, updateViaCache: 'none' });
    const check = async () => {
      const active = registration.active;
      if (!active) return;
      const result = await new Promise(resolve => { const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 15000); channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); }; active.postMessage({ type: 'VERIFY_CACHE' }, [channel.port2]); });
      if (result?.ready && result.version === __BUILD_VERSION__) {
        // On the very first visit, take control with this already active,
        // verified version BEFORE allowing any identity to be unlocked.
        // This does not activate an update or call skipWaiting.
        if (!navigator.serviceWorker.controller) {
          await new Promise(resolve => { const channel = new MessageChannel(); const timer = setTimeout(() => { channel.port1.close(); resolve(); }, 5000); channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(); }; active.postMessage({ type: 'CLAIM_VERIFIED_BUILD', version: __BUILD_VERSION__ }, [channel.port2]); });
        }
        runtimeReady = Boolean(navigator.serviceWorker.controller);
        $('offline-status').textContent = runtimeReady ? 'Офлайн готов' : 'Откройте приложение заново';
        $('offline-status').classList.toggle('ready', runtimeReady);
      }
      else $('offline-status').textContent = 'Офлайн не подтверждён';
      show('update-notice', Boolean(registration.waiting));
    };
    registration.addEventListener('updatefound', () => { registration.installing?.addEventListener('statechange', () => { if (registration.waiting) show('update-notice'); if (registration.active) check(); }); });
    await navigator.serviceWorker.ready; await check();
  } catch { $('offline-status').textContent = 'Офлайн не подтверждён'; }
}
offlineReady();
