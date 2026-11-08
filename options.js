/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
(async function () {
  const { el, icon, monogram, summary } = FFUI;
  const MAX_PROFILES = 20, MAX_RULES = 50;
  const $ = (id) => document.getElementById(id);

  let state = null;
  let selectedId = null;
  let view = 'profile'; // 'profile' | 'settings'
  let screen = ''; // which gate screen is showing: 'unlock' reacts to an unlock made in the popup or another tab
  const current = () => state.profiles.find((p) => p.id === selectedId) || state.profiles[0];

  /* ---------- saving ---------- */
  // lastCt is the ciphertext of our own latest write. Comparing it (not the decoded object, whose key order Chrome
  // changes) is how this page tells its own saves apart from changes made in the popup or another tab.
  let timer = null, savedTimer = null, lastCt = null, inflight = Promise.resolve();
  async function saveNow() {
    clearTimeout(timer); timer = null;
    if (!state) return;
    // Chrome can announce a write before it resolves, so the change listener waits on this first.
    inflight = FF.save(state).then((ct) => { lastCt = ct; });
    try {
      await inflight;
    } catch (e) {
      if (e instanceof FFVault.LockedError) { toast('Smriti locked before your last change was saved. Unlock to keep editing.', true); boot(); }
      else toast('Could not save: ' + e.message, true);
      throw e;
    }
  }
  function queueSave() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await saveNow(); } catch (e) { return; }
      $('saved').textContent = 'Saved';
      $('saved').classList.add('on');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { $('saved').classList.remove('on'); $('saved').textContent = ''; }, 1400);
    }, 300);
  }
  // Closing the tab within the debounce window must not lose the last keystrokes.
  document.addEventListener('visibilitychange', () => { if (document.hidden && timer) saveNow().catch(() => {}); });
  // "Lock after every fill" also locks when the editor is closed.
  window.addEventListener('pagehide', () => { FFVault.getLock().then((l) => { if (l === 'fill') FFVault.lockNow(); }); });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'session' && changes.ffkey) {
      if (!changes.ffkey.newValue && state) { // locked elsewhere or idle
        if (timer) toast('Smriti locked before your last change was saved. Unlock to keep editing.', true);
        boot();
      } else if (changes.ffkey.newValue && !changes.ffkey.oldValue && screen === 'unlock') boot(); // unlocked elsewhere
      return;
    }
    if (area !== 'local') return;
    if (changes.vault && !changes.vault.newValue) { boot(); return; } // erased in another tab
    if (!changes.vault || !state || timer) return;
    await inflight.catch(() => {});
    if (timer || changes.vault.newValue.data.ct === lastCt) return;
    try { state = await FF.load(); } catch (e) { return; }
    lastCt = changes.vault.newValue.data.ct;
    if (!state.profiles.some((p) => p.id === selectedId)) selectedId = state.activeId;
    keepFocus(renderAll);
  });

  // Re-rendering replaces every control; put focus (and the caret) back on the matching new one.
  function keepFocus(render) {
    const a = document.activeElement, all = () => [...document.querySelectorAll('#editor input, #editor button, #editor select, .rail button')];
    const i = all().indexOf(a), caret = a && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    render();
    const n = i >= 0 && all()[i];
    if (!n) return;
    n.focus();
    if (caret && typeof n.selectionStart === 'number') try { n.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ }
  }
  const focusCurrent = () => { const c = document.querySelector('.rail-item[aria-current]'); if (c) c.focus(); };
  const focusName = () => { const n = document.querySelector('.name-input'); if (n) n.focus(); };

  /* ---------- dialog and toast (no blocking alert/confirm) ---------- */
  // Plain confirm: resolves true/false. With `fields`, resolves the typed values (or null), and `check`
  // may throw to keep the dialog open with an error, e.g. on a wrong password.
  function ask({ title, body, ok, danger, fields, check }) {
    return new Promise((resolve) => {
      const d = $('dlg');
      $('dlgTitle').textContent = title;
      $('dlgBody').textContent = body || '';
      $('dlgOk').textContent = ok;
      $('dlgOk').classList.toggle('destructive', !!danger);
      $('dlgError').textContent = '';
      const box = $('dlgFields'); box.textContent = '';
      const inputs = (fields || []).map((f) => {
        const i = el('input', { type: f.type || 'password', autocomplete: f.autocomplete || 'off', spellcheck: false });
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('dlgOk').click(); } });
        box.appendChild(el('label', { className: 'field' }, el('span', { textContent: f.label }), i));
        return i;
      });
      let answer = fields ? null : false, busy = false;
      const hold = (e) => { if (busy) e.preventDefault(); }; // Esc must not abandon a password change half done
      const finish = () => {
        d.removeEventListener('close', finish); d.removeEventListener('cancel', hold);
        $('dlgOk').onclick = null; $('dlgCancel').onclick = null;
        inputs.forEach((i) => { i.value = ''; }); box.textContent = '';
        resolve(answer);
      };
      $('dlgOk').onclick = async () => {
        if (!fields) { answer = true; d.close(); return; }
        const values = inputs.map((i) => i.value);
        $('dlgOk').disabled = true; $('dlgCancel').disabled = true; busy = true; $('dlgError').textContent = '';
        try {
          answer = check ? await check(values) : values;
          d.close();
        } catch (e) { $('dlgError').textContent = e.message; inputs[0].select(); answer = null; }
        finally { $('dlgOk').disabled = false; $('dlgCancel').disabled = false; busy = false; }
      };
      $('dlgCancel').onclick = () => d.close();
      d.addEventListener('close', finish); d.addEventListener('cancel', hold);
      d.showModal();
      (inputs[0] || $('dlgCancel')).focus(); // without fields the safe choice has focus, so Enter cannot erase anything
    });
  }
  let toastTimer = null;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text;
    t.className = 'on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, bad ? 7000 : 3000);
  }

  /* ---------- gate screens: setup, recovery key, unlock, recover ---------- */
  function gate(title, lead, ...kids) {
    screen = 'gate';
    document.body.classList.add('gated');
    $('saved').classList.remove('on');
    const root = $('editor');
    root.textContent = '';
    const g = el('section', { className: 'gate' }, el('h1', { textContent: title }), lead ? el('p', { className: 'muted lead', textContent: lead }) : null, ...kids);
    root.appendChild(g);
    const first = g.querySelector('input'); if (first) first.focus();
    return g;
  }
  const pwField = (label, autocomplete) => {
    const i = el('input', { type: 'password', autocomplete, spellcheck: false });
    return { input: i, node: el('label', { className: 'field' }, el('span', { textContent: label }), i) };
  };
  function formOf(button, run) {
    const err = el('p', { className: 'form-error', role: 'alert' });
    const f = el('form', { className: 'gate-form' });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      button.disabled = true; err.textContent = '';
      try { await run(); } catch (x) { err.textContent = x.message; } finally { button.disabled = false; }
    });
    return { form: f, err };
  }

  async function showSetup(legacy) {
    const a = pwField('Password', 'new-password'), b = pwField('Confirm password', 'new-password');
    const go = el('button', { type: 'submit', className: 'btn primary', textContent: 'Encrypt and continue' });
    const { form, err } = formOf(go, async () => {
      if (a.input.value !== b.input.value) throw new Error('The passwords do not match.');
      FFVault.checkPassword(a.input.value);
      go.textContent = 'Encrypting';
      const initial = legacy ? await FF.legacyState() : FF.defaultState();
      try { showRecoveryKey(await FFVault.setup(a.input.value, initial), true); }
      finally { go.textContent = 'Encrypt and continue'; a.input.value = ''; b.input.value = ''; }
    });
    form.append(a.node, b.node, el('small', { className: 'muted', textContent: 'At least 8 characters. A phrase of four or more random words is easy to remember and hard to guess.' }), err, el('div', { className: 'bar flush' }, go));
    gate('Protect your profiles with a password',
      (legacy ? 'Your existing profiles will be encrypted and the unencrypted copy removed. ' : '') +
      'Your details are encrypted with AES-256 using this password. It never leaves this device, and nobody can reset it for you.', form);
  }

  function showRecoveryKey(code, firstTime) {
    // One span per group, so the key only ever wraps between groups.
    const groups = code.split('-');
    const codeEl = el('p', { className: 'recovery-code' }, ...groups.map((g, i) => el('span', { textContent: g + (i < groups.length - 1 ? '-' : '') })));
    const copy = el('button', { type: 'button', className: 'btn' }, icon('copy'), 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); toast('Recovery key copied. Paste it somewhere safe, then clear your clipboard.'); }
      catch (e) { getSelection().selectAllChildren(codeEl); toast('Press Ctrl+C to copy the selected key.'); }
    });
    const save = el('button', { type: 'button', className: 'btn' }, icon('folder'), 'Save to Smriti Backups');
    save.addEventListener('click', () => saveFile('smriti-recovery-key.txt', new Blob(['Smriti recovery key\n\n' + code + '\n\nKeep this private. It unlocks your profiles if you forget your password.\n'], { type: 'text/plain' })));
    const ack = el('input', { type: 'checkbox' });
    const cont = el('button', { type: 'button', className: 'btn primary', textContent: 'Continue', disabled: true });
    ack.addEventListener('change', () => { cont.disabled = !ack.checked; });
    cont.addEventListener('click', () => { codeEl.textContent = ''; boot(); });
    gate(firstTime ? 'Save your recovery key' : 'Your new recovery key',
      'If you forget your password, this key is the only way back in. Store it offline, such as on paper or in a password manager. ' +
      (firstTime ? 'It is shown only once.' : 'Your previous recovery key no longer works.'),
      codeEl, el('div', { className: 'bar flush' }, copy, save),
      el('label', { className: 'ack' }, ack, el('span', { textContent: 'I have saved my recovery key somewhere safe' })),
      el('div', { className: 'bar flush' }, cont));
  }

  function showUnlock() {
    const a = pwField('Password', 'current-password');
    const go = el('button', { type: 'submit', className: 'btn primary', textContent: 'Unlock' });
    const { form, err } = formOf(go, async () => {
      go.textContent = 'Unlocking'; screen = 'unlocking';
      try { await FFVault.unlock(a.input.value); a.input.value = ''; await boot(); }
      catch (e) { screen = 'unlock'; a.input.select(); throw e; }
      finally { go.textContent = 'Unlock'; }
    });
    const forgot = el('button', { type: 'button', className: 'link-btn', textContent: 'Forgot password? Use your recovery key' });
    forgot.addEventListener('click', showRecover);
    form.append(a.node, err, el('div', { className: 'bar flush' }, go, forgot));
    gate('Smriti is locked', 'Enter your password to view and edit your profiles.', form);
    screen = 'unlock';
  }

  function showRecover() {
    const k = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
    const a = pwField('New password', 'new-password'), b = pwField('Confirm new password', 'new-password');
    const go = el('button', { type: 'submit', className: 'btn primary', textContent: 'Set new password' });
    const { form, err } = formOf(go, async () => {
      if (a.input.value !== b.input.value) throw new Error('The passwords do not match.');
      await FFVault.recover(k.value, a.input.value);
      k.value = ''; a.input.value = ''; b.input.value = '';
      await boot();
      toast('Password changed. Your recovery key still works.');
    });
    const back = el('button', { type: 'button', className: 'link-btn', textContent: 'Back to unlock' });
    back.addEventListener('click', showUnlock);
    const wipe = el('button', { type: 'button', className: 'btn danger' }, icon('trash'), 'Erase everything and start over');
    wipe.addEventListener('click', eraseAll);
    form.append(el('label', { className: 'field' }, el('span', { textContent: 'Recovery key' }), k), a.node, b.node, err, el('div', { className: 'bar flush' }, go, back));
    gate('Reset your password', 'Enter the recovery key you saved when you set up Smriti, then choose a new password.', form,
      el('div', { className: 'gate-danger' }, el('p', { className: 'muted', textContent: 'Lost the recovery key too? Your data cannot be decrypted by anyone. You can only erase it and start again.' }), wipe));
  }

  async function boot() {
    clearTimeout(timer); timer = null;
    const status = await FFVault.status();
    if (status === 'new' || status === 'legacy') { state = null; return showSetup(status === 'legacy'); }
    if (status === 'locked') {
      state = null;
      if (location.hash === '#recover') { history.replaceState(null, '', location.pathname); return showRecover(); }
      return showUnlock();
    }
    state = await FF.load();
    lastCt = (await chrome.storage.local.get('vault')).vault.data.ct;
    if (!state.profiles.some((p) => p.id === selectedId)) selectedId = state.activeId;
    screen = '';
    document.body.classList.remove('gated');
    renderAll();
  }

  /* ---------- rail ---------- */
  function renderSide() {
    const list = $('profileList');
    list.textContent = '';
    state.profiles.forEach((p) => {
      const on = view === 'profile' && p.id === selectedId;
      const b = el('button', { type: 'button', className: 'rail-item' },
        el('span', { className: 'monogram small', textContent: monogram(p.name) }),
        el('span', { className: 'rail-text' },
          el('span', { className: 'rail-name', textContent: p.name || 'Unnamed profile' }),
          el('span', { className: 'rail-sub', textContent: p.id === state.activeId ? 'Default' : summary(p) })));
      if (on) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => { selectedId = p.id; view = 'profile'; renderAll(); focusCurrent(); });
      list.appendChild(b);
    });
    $('addProfile').disabled = state.profiles.length >= MAX_PROFILES;
    $('addProfile').title = state.profiles.length >= MAX_PROFILES ? 'You can keep up to ' + MAX_PROFILES + ' profiles' : '';
    if (view === 'settings') $('openSettings').setAttribute('aria-current', 'true');
    else $('openSettings').removeAttribute('aria-current');
  }

  /* ---------- profile editor ---------- */
  function renderProfile(root) {
    const p = current();

    const nameInput = el('input', { type: 'text', value: p.name, maxLength: 60, className: 'name-input', spellcheck: false });
    nameInput.setAttribute('aria-label', 'Profile name');
    nameInput.addEventListener('input', () => { p.name = nameInput.value; renderSide(); queueSave(); });
    const isDefault = p.id === state.activeId;
    const defBtn = el('button', { type: 'button', className: 'btn', textContent: isDefault ? 'Default profile' : 'Make default' });
    defBtn.disabled = isDefault;
    defBtn.addEventListener('click', () => { state.activeId = p.id; renderAll(); focusName(); queueSave(); });
    root.appendChild(el('header', { className: 'name-row' }, nameInput, defBtn));

    root.appendChild(el('p', { className: 'notice', textContent: 'Encrypted with your password and never sent anywhere. Do not store passwords, card numbers or government ID numbers here. Smriti refuses to fill those fields, even if you add a rule for them.' }));

    ['Personal', 'Work and web', 'Address'].forEach((g) => {
      const grid = el('div', { className: 'grid' });
      FF.FIELDS.filter((f) => f.group === g).forEach((f) => {
        const input = el('input', { type: f.type || 'text', value: p.values[f.key] || '', maxLength: 500, autocomplete: 'off', spellcheck: false });
        input.addEventListener('input', () => {
          const v = input.value.trim();
          if (v) p.values[f.key] = v; else delete p.values[f.key];
          renderSide();
          queueSave();
        });
        grid.appendChild(el('label', { className: 'field' }, el('span', { textContent: f.label }), input, f.hint ? el('small', { textContent: f.hint }) : null));
      });
      root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: g }), grid));
    });

    // custom rules
    const rules = el('div', { className: 'rules' });
    function drawRules() {
      rules.textContent = '';
      if (!p.custom.length) rules.appendChild(el('p', { className: 'muted', textContent: 'Add a rule when a form uses a label Smriti does not recognise.' }));
      p.custom.forEach((r, i) => {
        const m = el('input', { type: 'text', value: r.match, placeholder: 'Field text, e.g. notice period, expected ctc', maxLength: 120, spellcheck: false });
        const v = el('input', { type: 'text', value: r.value, placeholder: 'Value to fill', maxLength: 500, autocomplete: 'off', spellcheck: false });
        m.setAttribute('aria-label', 'Match words'); v.setAttribute('aria-label', 'Value');
        m.addEventListener('input', () => { r.match = m.value; queueSave(); });
        v.addEventListener('input', () => { r.value = v.value; queueSave(); });
        const del = el('button', { type: 'button', className: 'btn icon-only' }, icon('x'));
        del.setAttribute('aria-label', 'Remove rule');
        del.title = 'Remove rule';
        del.addEventListener('click', () => {
          p.custom.splice(i, 1); drawRules(); renderSide(); queueSave();
          const left = rules.querySelectorAll('.rule');
          (left[Math.min(i, left.length - 1)] || rules).querySelector('input, button').focus();
        });
        rules.appendChild(el('div', { className: 'rule' }, m, v, del));
      });
      const add = el('button', { type: 'button', className: 'btn' }, icon('plus'), 'Add custom rule');
      add.disabled = p.custom.length >= MAX_RULES;
      add.addEventListener('click', () => {
        if (p.custom.length < MAX_RULES) { p.custom.push({ match: '', value: '' }); drawRules(); rules.querySelector('.rule:last-of-type input').focus(); queueSave(); }
      });
      rules.appendChild(add);
    }
    drawRules();
    root.appendChild(el('section', { className: 'group' },
      el('div', {},
        el('h2', { textContent: 'Custom rules' })),
      el('div', {},
        el('p', { className: 'muted lead', textContent: 'Fill any field whose label, placeholder or name contains these words. Separate alternatives with commas. Custom rules win over built-in matching.' }),
        rules)));

    const dup = el('button', { type: 'button', className: 'btn' }, icon('copy'), 'Duplicate profile');
    dup.disabled = state.profiles.length >= MAX_PROFILES;
    dup.addEventListener('click', () => {
      if (state.profiles.length >= MAX_PROFILES) return;
      const c = JSON.parse(JSON.stringify(p)); c.id = FF.uid(); c.name = p.name.slice(0, 55) + ' copy';
      state.profiles.push(c); selectedId = c.id; renderAll(); focusName(); queueSave();
    });
    const del = el('button', { type: 'button', className: 'btn danger' }, icon('trash'), 'Delete profile');
    del.disabled = state.profiles.length < 2;
    del.addEventListener('click', async () => {
      if (!await ask({ title: 'Delete "' + p.name + '"?', body: 'Its details and custom rules are removed from this device. This cannot be undone.', ok: 'Delete profile', danger: true })) return;
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      if (state.activeId === p.id) state.activeId = state.profiles[0].id;
      selectedId = state.activeId; renderAll(); focusName(); queueSave();
    });
    root.appendChild(el('div', { className: 'bar' }, dup, del));
  }

  /* ---------- settings and backup ---------- */
  const LOCK_LABELS = { 5: 'After 5 minutes without use', 15: 'After 15 minutes without use', 60: 'After 1 hour without use', session: 'When Chrome closes', fill: 'After every fill' };

  function renderSettings(root) {
    root.appendChild(el('header', { className: 'name-row' }, el('h1', { textContent: 'Settings and backup' })));

    const toggle = (key, title, desc) => {
      const c = el('input', { type: 'checkbox', className: 'switch', checked: state.settings[key] });
      c.addEventListener('change', () => { state.settings[key] = c.checked; queueSave(); });
      return el('label', { className: 'toggle' }, el('span', { className: 'toggle-text' }, el('strong', { textContent: title }), el('span', { textContent: desc })), c);
    };
    root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: 'Filling' }), el('div', { className: 'stack' },
      toggle('overwrite', 'Replace existing text', 'Overwrite fields that already have a value. When off, those fields are left alone.'),
      toggle('allFrames', 'Fill inside iframes', 'Include visible frames from the same site as the page.'),
      toggle('blockInsecure', 'Refuse http:// pages', 'Anything typed on an unencrypted page can be read in transit. Localhost is exempt.'))));

    // security
    const lockSel = el('select', { id: 'lockAfter' }, ...FFVault.LOCKS.map((v) => el('option', { value: v, textContent: LOCK_LABELS[v] })));
    FFVault.getLock().then((v) => { lockSel.value = v; });
    lockSel.addEventListener('change', async () => { await FFVault.setLock(lockSel.value); toast('Lock setting saved.'); });
    const lockNow = el('button', { type: 'button', className: 'btn' }, icon('lock'), 'Lock now');
    lockNow.addEventListener('click', async () => { await saveNow().catch(() => {}); await FFVault.lockNow(); boot(); });
    const changePw = el('button', { type: 'button', className: 'btn', textContent: 'Change password' });
    changePw.addEventListener('click', changePassword);
    const newKey = el('button', { type: 'button', className: 'btn', textContent: 'New recovery key' });
    newKey.addEventListener('click', async () => {
      if (!await ask({ title: 'Create a new recovery key?', body: 'Your current recovery key stops working. Save the new one before you leave the next screen.', ok: 'Create new key' })) return;
      showRecoveryKey(await FFVault.newRecoveryCode(), false);
    });
    root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: 'Security' }), el('div', { className: 'stack' },
      el('label', { className: 'field' }, el('span', { textContent: 'Lock Smriti' }), lockSel,
        el('small', { textContent: 'Locked means your password is needed before filling or editing. The keyboard shortcut works only while unlocked.' })),
      el('div', { className: 'bar flush' }, lockNow, changePw, newKey))));

    const shortcutRow = el('div', { className: 'stack' });
    const change = el('button', { type: 'button', className: 'btn', textContent: 'Change shortcut' });
    change.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
    const keys = el('p', { className: 'muted', textContent: 'Fills the active tab with your default profile.' });
    chrome.commands.getAll((cmds) => {
      const c = (cmds || []).find((x) => x.name === 'fill-form');
      if (c && c.shortcut) keys.prepend(el('kbd', { textContent: c.shortcut }), ' ');
      else keys.textContent = 'No shortcut is set. Chrome skips the default when another extension already uses it.';
    });
    shortcutRow.append(keys, el('div', { className: 'bar flush' }, change));
    root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: 'Keyboard shortcut' }), shortcutRow));

    const ex = el('button', { type: 'button', className: 'btn' }, icon('lock'), 'Export encrypted backup');
    const im = el('button', { type: 'button', className: 'btn', textContent: 'Import backup' });
    ex.addEventListener('click', exportBackup);
    im.addEventListener('click', () => $('importFile').click());
    const folderName = el('strong', { id: 'backupFolder', textContent: 'Not chosen yet' });
    folderLabel().then((n) => { if (n) folderName.textContent = n; });
    const pick = el('button', { type: 'button', className: 'btn' }, icon('folder'), 'Choose folder');
    pick.addEventListener('click', async () => {
      try { const d = await chooseFolder(); folderName.textContent = d.name; toast('Backups will be saved to ' + d.name + '.'); }
      catch (e) { if (e.name !== 'AbortError') toast('Could not use that folder: ' + e.message, true); }
    });
    root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: 'Backup' }), el('div', { className: 'stack' },
      el('p', { className: 'muted', textContent: 'Backups are encrypted with your password as it is when you export. Importing replaces everything here, and also accepts unencrypted exports from earlier versions.' }),
      el('p', { className: 'folder-line' }, icon('folder'), 'Saving to ', folderName),
      el('small', { className: 'muted', textContent: 'Backups and recovery keys are saved here. Choose the "Smriti Backups" folder that came with Smriti, or any folder you like.' }),
      el('div', { className: 'bar flush' }, ex, im, pick))));

    const wipe = el('button', { type: 'button', className: 'btn danger' }, icon('trash'), 'Erase all data');
    wipe.addEventListener('click', eraseAll);
    root.appendChild(el('section', { className: 'group' }, el('h2', { textContent: 'Erase' }), el('div', { className: 'stack' },
      el('p', { className: 'muted', textContent: 'Removes every profile, setting and your password from this browser. Uninstalling the extension does the same.' }),
      el('div', { className: 'bar flush' }, wipe))));
  }

  async function changePassword() {
    const done = await ask({
      title: 'Change password', ok: 'Change password',
      body: 'Backups you already exported still open with the password they were made with.',
      fields: [{ label: 'Current password', autocomplete: 'current-password' }, { label: 'New password', autocomplete: 'new-password' }, { label: 'Confirm new password', autocomplete: 'new-password' }],
      check: async ([cur, next, again]) => {
        if (next !== again) throw new Error('The new passwords do not match.');
        await FFVault.changePassword(cur, next);
        return true;
      },
    });
    if (done) toast('Password changed.');
  }

  function renderEditor() {
    const root = $('editor');
    root.textContent = '';
    if (view === 'settings') renderSettings(root); else renderProfile(root);
  }
  function renderAll() { renderSide(); renderEditor(); }

  /* ---------- backup folder ---------- */
  // Backups and recovery keys go to one folder the user picks once, normally the "Smriti Backups" folder shipped
  // next to the extension. Its handle lives in this extension's IndexedDB; Chrome may ask again for write access
  // after a restart. Without the File System Access API, files fall back to an ordinary download.
  function kv(mode, run) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('smriti', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('kv');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('kv', mode), req = run(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); resolve(req.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const savedFolder = () => kv('readonly', (s) => s.get('backupDir')).catch(() => null);
  const forgetFolder = () => kv('readwrite', (s) => s.delete('backupDir')).catch(() => {});
  const folderLabel = async () => { const d = await savedFolder(); return d ? d.name : ''; };
  async function chooseFolder() {
    const d = await window.showDirectoryPicker({ id: 'smriti-backups', mode: 'readwrite', startIn: 'downloads' });
    await kv('readwrite', (s) => s.put(d, 'backupDir'));
    const n = $('backupFolder'); if (n) n.textContent = d.name;
    return d;
  }
  // Must run straight from a click: the picker and the permission prompt both need a user gesture.
  async function backupFolder() {
    const d = await savedFolder();
    if (d) {
      const opts = { mode: 'readwrite' };
      if (await d.queryPermission(opts) === 'granted' || await d.requestPermission(opts) === 'granted') return d;
    }
    return chooseFolder();
  }
  function download(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function writeTo(dir, name, blob) {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    try { await w.write(blob); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
    toast('Saved ' + name + ' to ' + dir.name + '.');
  }
  // Returns false when the user cancels the folder picker.
  async function saveFile(name, blob, dir) {
    if (!window.showDirectoryPicker) { download(blob, name); return true; }
    try {
      await writeTo(dir || await backupFolder(), name, blob);
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      toast('Could not save to the backup folder (' + e.message + '). Saving to Downloads instead.', true);
      download(blob, name);
      return true;
    }
  }
  const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()); };

  /* ---------- backup actions ---------- */
  async function exportBackup() {
    // Pick or re-open the folder first, while the click still counts as a user gesture.
    let dir = null;
    if (window.showDirectoryPicker) {
      try { dir = await backupFolder(); } catch (e) { if (e.name === 'AbortError') return; }
    }
    await saveNow().catch(() => {});
    const text = await ask({
      title: 'Export encrypted backup', ok: 'Export',
      body: 'Enter your password. The backup opens only with this password, even if you change it later.',
      fields: [{ label: 'Password', autocomplete: 'current-password' }],
      check: ([pw]) => FFVault.exportBackup(pw),
    });
    if (!text) return;
    const blob = new Blob([text], { type: 'application/octet-stream' }), name = 'smriti-backup-' + stamp() + '.smriti';
    if (dir) await saveFile(name, blob, dir); else download(blob, name);
  }

  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 1024 * 1024) { toast('Choose a backup file under 1 MB.', true); return; }
    try {
      let imported;
      if (/\.xlsx$/i.test(f.name)) imported = FF.fromSheets(await FFXlsx.parse(await f.arrayBuffer()));
      else {
        const text = await f.text();
        let obj = null; try { obj = JSON.parse(text); } catch (x) { /* fromJson reports it */ }
        if (FFVault.isBackup(obj)) {
          const raw = await ask({ title: 'Open encrypted backup', ok: 'Open', body: 'Enter the password this backup was exported with.',
            fields: [{ label: 'Backup password', autocomplete: 'off' }], check: ([pw]) => FFVault.openBackup(obj, pw) });
          if (!raw) return;
          imported = FF.fromJson(JSON.stringify(raw));
        } else imported = FF.fromJson(text);
      }
      const n = imported.profiles.length;
      if (!await ask({ title: 'Replace all current profiles?', body: 'Your current profiles and settings are replaced by ' + FFUI.plural(n, 'imported profile') + '. This cannot be undone.', ok: 'Replace profiles', danger: true })) return;
      state = imported; selectedId = state.activeId; view = 'profile'; renderAll();
      await saveNow();
      toast('Imported ' + FFUI.plural(n, 'profile') + '.' + (/\.(json|xlsx)$/i.test(f.name) ? ' Delete the unencrypted file you imported from.' : ''));
    } catch (err) { if (!(err instanceof FFVault.LockedError)) toast('Could not import this file: ' + (err && err.message ? err.message : 'unreadable'), true); }
  });
  async function eraseAll() {
    if (!await ask({ title: 'Erase all data?', body: 'Every profile, setting and your password are removed from this browser. This cannot be undone.', ok: 'Erase all data', danger: true })) return;
    clearTimeout(timer); timer = null; // a pending save must not write the erased data back
    state = null;
    await FFVault.erase();
    await forgetFolder();
    view = 'profile';
    await boot();
    toast('All data erased.');
  }

  /* ---------- wiring ---------- */
  $('addProfile').prepend(icon('plus'));
  $('openSettings').prepend(icon('gear'));
  $('railNote').prepend(icon('lock'));
  $('railMail').prepend(icon('mail'));
  const heart = icon('heart'); heart.classList.add('heart'); $('railHeart').replaceWith(heart);
  $('addProfile').addEventListener('click', () => {
    if (state.profiles.length >= MAX_PROFILES) return;
    const p = { id: FF.uid(), name: 'New profile', values: {}, custom: [] };
    state.profiles.push(p); selectedId = p.id; view = 'profile'; renderAll(); queueSave();
    const n = document.querySelector('.name-input'); n.focus(); n.select();
  });
  $('openSettings').addEventListener('click', () => { view = 'settings'; renderAll(); $('openSettings').focus(); });

  await boot();
})();
