/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
/* Shared by popup, options page and the service worker. No network access anywhere. */
(function () {
  const FIELDS = [
    { key: 'firstName', label: 'First name', group: 'Personal' },
    { key: 'lastName', label: 'Last name', group: 'Personal' },
    { key: 'fullName', label: 'Full name', group: 'Personal', hint: 'Blank uses first + last name' },
    { key: 'email', label: 'Email', group: 'Personal' },
    { key: 'phone', label: 'Phone', group: 'Personal' },
    { key: 'dob', label: 'Date of birth', group: 'Personal', type: 'date' },
    { key: 'username', label: 'Username', group: 'Personal' },
    { key: 'company', label: 'Company / organisation', group: 'Work and web' },
    { key: 'jobTitle', label: 'Job title', group: 'Work and web' },
    { key: 'website', label: 'Website', group: 'Work and web' },
    { key: 'linkedin', label: 'LinkedIn URL', group: 'Work and web' },
    { key: 'github', label: 'GitHub URL', group: 'Work and web' },
    { key: 'address1', label: 'Address line 1', group: 'Address' },
    { key: 'address2', label: 'Address line 2', group: 'Address' },
    { key: 'city', label: 'City', group: 'Address' },
    { key: 'state', label: 'State / province', group: 'Address' },
    { key: 'zip', label: 'ZIP / PIN code', group: 'Address' },
    { key: 'country', label: 'Country', group: 'Address' },
  ];
  const MAX_PROFILES = 20, MAX_RULES = 50;
  // Drops control characters and bidi overrides, which can disguise text in the UI.
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
  const clean = (s, n) => (typeof s === 'string' ? s.replace(CONTROL, '').slice(0, n || 500) : '');
  const uid = () => crypto.randomUUID().slice(0, 8);

  function defaultState() {
    const id = uid();
    return { version: 1, activeId: id, profiles: [{ id, name: 'Personal', values: {}, custom: [] }],
      settings: { overwrite: false, allFrames: true, blockInsecure: true } };
  }

  // Every read and import goes through this, so malformed or hostile JSON cannot reach the UI.
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.profiles) || !raw.profiles.length) return defaultState();
    const seenIds = new Set();
    const profiles = raw.profiles.slice(0, MAX_PROFILES).map((p) => {
      p = p && typeof p === 'object' ? p : {};
      const values = {};
      FIELDS.forEach((f) => { const v = clean(p.values && p.values[f.key]).trim(); if (v) values[f.key] = v; });
      const custom = (Array.isArray(p.custom) ? p.custom : []).slice(0, MAX_RULES)
        .map((r) => ({ match: clean(r && r.match, 120).trim(), value: clean(r && r.value) }))
        .filter((r) => r.match);
      let id = clean(p.id, 40);
      if (!id || seenIds.has(id)) id = uid(); // a duplicate id would make two profiles impossible to tell apart
      seenIds.add(id);
      return { id, name: clean(p.name, 60).trim() || 'Profile', values, custom };
    });
    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const activeId = profiles.some((p) => p.id === raw.activeId) ? raw.activeId : profiles[0].id;
    return { version: 1, activeId, profiles,
      settings: { overwrite: s.overwrite === true, allFrames: s.allFrames !== false, blockInsecure: s.blockInsecure !== false } };
  }


  // Strict import: unlike sanitize, this rejects junk instead of silently replacing the user's data with an empty profile.
  function fromJson(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new Error('This file is not valid JSON.'); }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.profiles) || !raw.profiles.length) throw new Error('This file has no Smriti profiles in it.');
    return sanitize(raw);
  }

  /* ---------- import of unencrypted v1/v2.0 Excel exports ---------- */
  const SHEET_PROFILES = 'Profiles', SHEET_SETTINGS = 'Settings';
  // sheets: { sheetName: string[][] } from FFXlsx.parse. Throws on unusable input.
  function fromSheets(sheets) {
    const rows = sheets[SHEET_PROFILES];
    if (!rows || rows.length < 2) throw new Error('No "Profiles" sheet found in this workbook.');
    const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
    const col = (n) => header.indexOf(n);
    const ci = { p: col('profile'), t: col('type'), k: col('key'), v: col('value') };
    if (Object.values(ci).some((i) => i < 0)) throw new Error('The Profiles sheet needs the columns Profile, Type, Key, Value.');
    const byName = new Map(); let defaultName = null;
    const get = (name) => { if (!byName.has(name)) byName.set(name, { id: uid(), name, values: {}, custom: [] }); return byName.get(name); };
    rows.slice(1).forEach((r) => {
      const name = String(r[ci.p] || '').trim(), type = String(r[ci.t] || '').trim().toLowerCase();
      const key = String(r[ci.k] || '').trim(), value = String(r[ci.v] || '');
      if (!name) return;
      const p = get(name);
      if (type === 'profile') { if (value.trim().toLowerCase() === 'default') defaultName = name; }
      else if (type === 'field') { if (FIELDS.some((f) => f.key === key) && value.trim()) p.values[key] = value.trim(); }
      else if (type === 'rule') { if (key) p.custom.push({ match: key, value }); }
    });
    if (!byName.size) throw new Error('No profiles found in this workbook.');
    const profiles = Array.from(byName.values());
    const settings = { overwrite: false, allFrames: true, blockInsecure: true };
    (sheets[SHEET_SETTINGS] || []).slice(1).forEach((r) => {
      const k = String((r && r[0]) || '').trim(), v = String((r && r[1]) || '').trim().toUpperCase();
      if (Object.hasOwn(settings, k) && (v === 'TRUE' || v === 'FALSE')) settings[k] = v === 'TRUE';
    });
    const def = profiles.find((p) => p.name === defaultName) || profiles[0];
    return sanitize({ activeId: def.id, profiles, settings });
  }

  // Profiles live encrypted in the vault. Both throw FFVault.LockedError while locked.
  async function load() { return sanitize(await FFVault.read()); }
  async function save(state) { return FFVault.write(sanitize(state)); }
  // Unencrypted data left by v2.0 or earlier, which setup encrypts and then deletes.
  async function legacyState() {
    const { state } = await chrome.storage.local.get('state');
    return sanitize(state);
  }

  async function fillTab(tabId, profileId) {
    let state;
    try { state = await load(); } catch (e) {
      if (e instanceof FFVault.LockedError) return { locked: true };
      return { error: e.message === 'Set a password first.' ? 'Set a password in Smriti before filling.' : 'Could not read your profiles.' };
    }
    const profile = state.profiles.find((p) => p.id === (profileId || state.activeId)) || state.profiles[0];
    const values = Object.assign({}, profile.values);
    if (!values.fullName && (values.firstName || values.lastName)) {
      values.fullName = [values.firstName, values.lastName].filter(Boolean).join(' ');
    }
    if (!Object.keys(values).length && !profile.custom.length) return { empty: true, profile: profile.name };

    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: state.settings.allFrames },
        world: 'ISOLATED', // page scripts cannot see the values passed in or tamper with this code
        func: formFillerMain,
        args: [{ values, custom: profile.custom, options: state.settings }],
      });
    } catch (e) {
      return { error: 'This page does not allow extensions to run (browser pages, the Chrome Web Store, and some PDFs are blocked).' };
    }
    const out = { profile: profile.name, filled: 0, skippedExisting: 0, details: [], warnings: [], blocked: false, missed: [] };
    results.forEach((r) => {
      const x = r && r.result;
      if (!x) return;
      out.filled += x.filled; out.skippedExisting += x.skippedExisting;
      if (x.blocked) out.blocked = x.blocked;
      x.details.forEach((d) => { if (out.details.length < 200) out.details.push(d); });
      (x.missed || []).forEach((m) => { if (out.missed.length < 20 && !out.missed.some((o) => o.label === m.label && o.reason === m.reason)) out.missed.push(m); });
      x.warnings.forEach((w) => { if (!out.warnings.includes(w)) out.warnings.push(w); });
    });
    if (await FFVault.getLock() === 'fill') await FFVault.lockNow();
    return out;
  }

  globalThis.FF = { FIELDS, uid, defaultState, sanitize, fromJson, load, save, legacyState, fillTab, fromSheets };
})();
