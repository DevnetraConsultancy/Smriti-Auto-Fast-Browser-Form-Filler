/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
/*
 * Encrypted profile vault, built only on the browser's WebCrypto.
 * Profiles are sealed with AES-256-GCM under a random data key. That key is stored twice, wrapped by a key derived
 * from the password (PBKDF2-SHA256, 600,000 iterations) and by one derived from the recovery key (HKDF-SHA256).
 * While unlocked, the raw data key lives only in chrome.storage.session: held in memory, cleared when Chrome closes,
 * and unreachable from web pages.
 */
(function () {
  const ITERATIONS = 600000;
  const LOCKS = ['5', '15', '60', 'session', 'fill'];
  const DEFAULT_LOCK = '15';
  const FILL_GRACE_MIN = 2; // "lock after every fill" still locks if the popup closes without filling
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const enc = new TextEncoder(), dec = new TextDecoder(), subtle = crypto.subtle;
  const local = chrome.storage.local, session = chrome.storage.session;

  class LockedError extends Error { constructor() { super('Smriti is locked.'); this.name = 'LockedError'; } }

  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw new Error('Use at least 8 characters.');
  }
  async function passwordKey(password, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Recovery keys are typed by hand, so O/I/L are read as 0/1 and dashes or spaces are ignored.
  const normCode = (code) => String(code || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
  async function recoveryKey(code, salt) {
    const base = await subtle.importKey('raw', enc.encode(normCode(code)), 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('form-filler recovery') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const dataKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  // The label goes in as additional data, so a sealed box cannot be moved into another slot.
  async function seal(key, bytes, label) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, bytes);
    return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  }
  async function unseal(key, box, label) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(label) }, key, unb64(box.ct)));
  }
  const iterationsOf = (kdf) => Math.min(Math.max(Number(kdf && kdf.iterations) || ITERATIONS, 100000), 5000000);

  function newCode() { // 160 random bits as 32 Crockford base32 characters, grouped in fours
    let bits = 0, val = 0, out = '';
    for (const b of rand(20)) {
      val = ((val << 8) | b) & 0xffff; bits += 8;
      while (bits >= 5) { out += CROCKFORD[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return out.match(/.{4}/g).join('-');
  }

  /* ---------- lock policy ---------- */
  async function getLock() {
    const { prefs } = await local.get('prefs');
    return prefs && LOCKS.includes(prefs.lock) ? prefs.lock : DEFAULT_LOCK;
  }
  async function schedule(lock) {
    if (!chrome.alarms) return;
    const minutes = lock === 'fill' ? FILL_GRACE_MIN : /^\d+$/.test(lock) ? Number(lock) : 0;
    if (minutes) await chrome.alarms.create('ff-lock', { delayInMinutes: minutes });
    else await chrome.alarms.clear('ff-lock');
  }
  async function setLock(lock) {
    if (!LOCKS.includes(lock)) throw new Error('Unknown lock setting.');
    const open = await currentKey(true);
    await local.set({ prefs: { lock } });
    if (open) await schedule(lock);
  }

  /* ---------- session key ---------- */
  async function remember(raw) {
    await session.set({ ffkey: { dk: b64(raw), touched: Date.now() } });
    await schedule(await getLock());
  }
  // The raw data key, or null when locked. Idle time is checked here as well, in case the alarm fired late.
  async function currentKey(touch) {
    const { ffkey } = await session.get('ffkey');
    if (!ffkey) return null;
    const lock = await getLock();
    const limit = lock === 'fill' ? FILL_GRACE_MIN : /^\d+$/.test(lock) ? Number(lock) : 0;
    if (limit && Date.now() - ffkey.touched > limit * 60000) { await lockNow(); return null; }
    if (touch) { ffkey.touched = Date.now(); await session.set({ ffkey }); await schedule(lock); }
    return unb64(ffkey.dk);
  }
  async function lockNow() {
    cached = null;
    await session.remove('ffkey');
    if (chrome.alarms) await chrome.alarms.clear('ff-lock');
  }

  async function getVault() { const { vault } = await local.get('vault'); return vault || null; }

  // Per-page cache of the unlocked key, so an autosave is one encryption and one write. Closing a tab
  // leaves too little time for the full round-trips. Locking or erasing anywhere drops it.
  let cached = null; // { key: CryptoKey, vault }
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((ch, areaName) => {
      if (areaName === 'session' && ch.ffkey && !ch.ffkey.newValue) cached = null;
      if (areaName === 'local' && ch.vault) cached = ch.vault.newValue && cached ? { key: cached.key, vault: ch.vault.newValue } : null;
    });
  }
  async function needVault() { const v = await getVault(); if (!v) throw new Error('Set a password first.'); return v; }

  /* ---------- public API ---------- */
  // 'new' (nothing stored), 'legacy' (unencrypted data from v2.0 or earlier), 'locked' or 'unlocked'.
  async function status() {
    const { vault, state } = await local.get(['vault', 'state']);
    if (!vault) return state ? 'legacy' : 'new';
    return (await currentKey(false)) ? 'unlocked' : 'locked';
  }

  // Encrypts `initial`, removes any unencrypted copy, unlocks, and returns the recovery key to show once.
  async function setup(password, initial) {
    checkPassword(password);
    if (await getVault()) throw new Error('A password is already set.');
    const raw = rand(32), salt = rand(16), rsalt = rand(16), code = newCode();
    const vault = {
      v: 1,
      kdf: { iterations: ITERATIONS, salt: b64(salt) },
      pw: await seal(await passwordKey(password, salt, ITERATIONS), raw, 'ff:key'),
      rk: { salt: b64(rsalt), ...(await seal(await recoveryKey(code, rsalt), raw, 'ff:key')) },
      data: await seal(await dataKey(raw), enc.encode(JSON.stringify(initial)), 'ff:data'),
    };
    await local.set({ vault });
    await local.remove('state');
    await remember(raw);
    return code;
  }

  async function unwrapWithPassword(vault, password) {
    try { return await unseal(await passwordKey(String(password), unb64(vault.kdf.salt), iterationsOf(vault.kdf)), vault.pw, 'ff:key'); }
    catch (e) { throw new Error('Wrong password.'); }
  }
  async function rewrapPassword(vault, raw, password) {
    const salt = rand(16);
    vault.kdf = { iterations: ITERATIONS, salt: b64(salt) };
    vault.pw = await seal(await passwordKey(password, salt, ITERATIONS), raw, 'ff:key');
  }

  async function unlock(password) {
    await remember(await unwrapWithPassword(await needVault(), password));
  }

  async function recover(code, newPassword) {
    checkPassword(newPassword);
    const vault = await needVault();
    let raw;
    try { raw = await unseal(await recoveryKey(code, unb64(vault.rk.salt)), vault.rk, 'ff:key'); }
    catch (e) { throw new Error('That recovery key does not match.'); }
    await rewrapPassword(vault, raw, newPassword);
    await local.set({ vault: { ...await needVault(), kdf: vault.kdf, pw: vault.pw } });
    await remember(raw);
  }

  async function changePassword(current, next) {
    checkPassword(next);
    const vault = await needVault();
    const raw = await unwrapWithPassword(vault, current);
    await rewrapPassword(vault, raw, next);
    // Re-read so an autosave made during the slow key derivation is kept.
    await local.set({ vault: { ...await needVault(), kdf: vault.kdf, pw: vault.pw } });
  }

  async function newRecoveryCode() {
    const raw = await currentKey(true);
    if (!raw) throw new LockedError();
    const rsalt = rand(16), code = newCode();
    const rk = { salt: b64(rsalt), ...(await seal(await recoveryKey(code, rsalt), raw, 'ff:key')) };
    await local.set({ vault: { ...await needVault(), rk } });
    return code;
  }

  async function read() {
    const raw = await currentKey(true);
    if (!raw) { cached = null; throw new LockedError(); }
    const vault = await needVault(), key = await dataKey(raw);
    const obj = JSON.parse(dec.decode(await unseal(key, vault.data, 'ff:data')));
    cached = { key, vault };
    return obj;
  }
  // Returns the new ciphertext, so callers can tell their own writes apart from other pages' writes.
  async function write(obj) {
    let key, vault;
    if (cached) {
      ({ key, vault } = cached);
      currentKey(true).catch(() => {}); // refresh the idle timer without delaying the save
    } else {
      const raw = await currentKey(true);
      if (!raw) throw new LockedError();
      vault = await needVault(); key = await dataKey(raw);
    }
    const next = { ...vault, data: await seal(key, enc.encode(JSON.stringify(obj)), 'ff:data') };
    await local.set({ vault: next });
    if (cached) cached.vault = next;
    return next.data.ct;
  }

  // Backups are sealed directly under the main password with a fresh salt, so no key is shared with the live vault.
  async function exportBackup(password) {
    const state = await read();
    await unwrapWithPassword(await needVault(), password);
    const salt = rand(16);
    const data = await seal(await passwordKey(password, salt, ITERATIONS), enc.encode(JSON.stringify(state)), 'ff:backup');
    // The format tag predates the Smriti name; it stays so older backups keep opening.
    return JSON.stringify({ format: 'form-filler-backup', v: 1, kdf: { iterations: ITERATIONS, salt: b64(salt) }, data });
  }
  const isBackup = (obj) => !!(obj && obj.format === 'form-filler-backup' && obj.kdf && obj.data && typeof obj.data.ct === 'string');
  async function openBackup(obj, password) {
    if (!isBackup(obj)) throw new Error('This is not a Smriti backup.');
    try {
      const key = await passwordKey(String(password), unb64(obj.kdf.salt), iterationsOf(obj.kdf));
      return JSON.parse(dec.decode(await unseal(key, obj.data, 'ff:backup')));
    } catch (e) { throw new Error('Wrong password for this backup.'); }
  }

  async function erase() {
    cached = null;
    await local.clear();
    await session.clear();
    if (chrome.alarms) await chrome.alarms.clear('ff-lock');
  }

  globalThis.FFVault = {
    LOCKS, LockedError, status, setup, unlock, recover, changePassword, newRecoveryCode, read, write,
    lockNow, getLock, setLock, exportBackup, openBackup, isBackup, erase, checkPassword,
  };
})();
