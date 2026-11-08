/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
(async function () {
  const { el, icon, monogram, summary, plural } = FFUI;
  const $ = (id) => document.getElementById(id);
  const sel = $('profile'), btn = $('fill'), out = $('result');
  let state = null;

  $('seal').prepend(icon('lock'));

  function renderIdentity() {
    const p = state.profiles.find((x) => x.id === sel.value) || state.profiles[0];
    $('monogram').textContent = monogram(p.name);
    $('summary').textContent = summary(p);
  }

  // One of three screens: set up a password, unlock, or fill.
  async function boot() {
    const status = await FFVault.status();
    const open = status === 'unlocked';
    $('setup').hidden = status !== 'new' && status !== 'legacy';
    $('unlock').hidden = status !== 'locked';
    btn.hidden = !open; $('lock').hidden = !open; sel.hidden = !open;
    $('pickLabel').hidden = !open;
    if (!open) {
      state = null;
      $('monogram').textContent = ''; $('monogram').append(icon('lock'));
      $('summary').textContent = status === 'locked' ? 'Locked. Enter your password to fill.' : 'No password set yet';
      if (status === 'locked') $('pw').focus();
      return;
    }
    state = await FF.load();
    sel.textContent = '';
    state.profiles.forEach((p) => sel.appendChild(el('option', { value: p.id, textContent: p.name })));
    sel.value = state.activeId;
    renderIdentity();
  }

  // Re-read before saving, so edits made in the options page since the popup opened are kept.
  sel.addEventListener('change', async () => {
    renderIdentity();
    try {
      const s = await FF.load();
      if (!s.profiles.some((p) => p.id === sel.value)) return;
      s.activeId = sel.value; state = s;
      await FF.save(s);
    } catch (e) { await boot(); }
  });

  $('unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('pw');
    $('unlockBtn').disabled = true; $('unlockBtn').textContent = 'Unlocking';
    $('pwError').textContent = '';
    try {
      await FFVault.unlock(pw.value);
      pw.value = '';
      await boot();
      btn.focus();
    } catch (err) {
      $('pwError').textContent = err.message;
      pw.select();
    } finally {
      $('unlockBtn').disabled = false; $('unlockBtn').textContent = 'Unlock';
    }
  });

  const openOptions = (hash) => (e) => {
    if (e) e.preventDefault();
    if (hash) chrome.tabs.create({ url: chrome.runtime.getURL('options.html' + hash) });
    else chrome.runtime.openOptionsPage(); // reuses an open options tab
    window.close();
  };
  $('edit').addEventListener('click', openOptions());
  $('setupBtn').addEventListener('click', openOptions());
  $('forgot').addEventListener('click', openOptions('#recover'));
  $('lock').addEventListener('click', async () => { await FFVault.lockNow(); out.textContent = ''; await boot(); });

  // The site about to receive the data. activeTab exposes the URL only for the tab the popup was opened on.
  // Started alongside boot() rather than before it, to save a round trip when the popup opens.
  const booting = boot();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(activeTab.url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const secure = u.protocol === 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
      const site = $('site');
      site.classList.toggle('insecure', !secure);
      site.append(icon(secure ? 'lock' : 'warn'), el('span', { className: 'host', textContent: u.hostname }));
      if (!secure) site.append(el('span', { className: 'site-note', textContent: 'Not encrypted' }));
      site.hidden = false;
    }
  } catch (e) { /* no URL to show on this page */ }

  chrome.commands.getAll((cmds) => {
    const c = (cmds || []).find((x) => x.name === 'fill-form');
    if (c && c.shortcut) $('shortcut').append(el('kbd', { textContent: c.shortcut }));
  });

  function box(cls, text) {
    return el('div', { className: 'status ' + cls }, icon(cls === 'ok' ? 'check' : 'warn'), el('span', { textContent: text }));
  }

  btn.addEventListener('click', async () => {
    out.textContent = '';
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const r = await FF.fillTab(tab.id, sel.value);
      if (r.locked) { await boot(); return; }
      if (r.error) out.appendChild(box('bad', r.error));
      else if (r.empty) out.appendChild(box('bad', '"' + r.profile + '" has no details yet. Open Edit profiles to add some.'));
      else if (r.blocked === 'insecure') out.appendChild(box('bad', 'Blocked: this page uses http://, so anything typed could be read in transit. You can change this in Settings.'));
      else {
        const msg = r.filled ? 'Filled ' + plural(r.filled, 'field') + '.' : 'No matching empty fields found.';
        const extra = r.skippedExisting ? ' ' + r.skippedExisting + ' already had text and ' + (r.skippedExisting === 1 ? 'was' : 'were') + ' left alone.' : '';
        out.appendChild(box(r.filled ? 'ok' : 'bad', msg + extra));
        if (r.filled) { $('pass').classList.remove('sealed'); void $('pass').offsetWidth; $('pass').classList.add('sealed'); }
        r.warnings.forEach((w) => out.appendChild(box('warn', w)));
        if (r.details.length) {
          out.appendChild(el('ul', { id: 'fields' }, ...r.details.map((d) => el('li', { textContent: d.label }))));
        }
        if (r.missed && r.missed.length) {
          out.appendChild(el('details', { className: 'missed' },
            el('summary', { textContent: 'Not filled (' + r.missed.length + ')' }),
            el('ul', {}, ...r.missed.map((m) => el('li', {}, el('strong', { textContent: m.label }), el('span', { textContent: m.reason }))))));
        }
      }
      if (await FFVault.status() !== 'unlocked') await boot(); // "lock after every fill"
    } catch (e) {
      out.appendChild(box('bad', 'Could not fill this page.'));
    } finally {
      btn.disabled = false;
    }
  });

  // In "lock after every fill" mode, closing the popup locks too.
  window.addEventListener('pagehide', () => { FFVault.getLock().then((l) => { if (l === 'fill') FFVault.lockNow(); }); });

  await booting;
})();
