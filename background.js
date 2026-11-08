/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
// The extension CSP enforces Trusted Types, and importScripts is a sink. This policy admits exactly the bundled files.
const SCRIPTS = ['filler.js', 'vault.js', 'shared.js'];
const policy = self.trustedTypes && self.trustedTypes.createPolicy('ffsw', {
  createScriptURL: (u) => { if (SCRIPTS.includes(u)) return u; throw new TypeError('Blocked script: ' + u); },
});
importScripts(...SCRIPTS.map((u) => (policy ? policy.createScriptURL(u) : u)));

// Keyboard shortcut: fill the active tab with the active profile.
const badgeTimers = new Map(); // tabId -> timer, so a second press keeps its badge for the full 3 s
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-form') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  const r = await FF.fillTab(tab.id).catch(() => ({ error: true }));
  if (r.locked) {
    // Locked: open the popup so the password can be entered (Chrome 127+); otherwise the badge points to it.
    try { await chrome.action.openPopup(); return; } catch (e) { /* fall through to the badge */ }
  }
  const bad = r.error || r.blocked || r.empty || r.locked;
  const text = r.locked ? 'LOCK' : r.error || r.blocked ? '!' : r.empty ? '?' : String(r.filled);
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: bad ? '#b3261e' : '#1b6b57' });
    await chrome.action.setBadgeText({ tabId: tab.id, text });
  } catch (e) { return; } // the tab closed while filling
  clearTimeout(badgeTimers.get(tab.id));
  badgeTimers.set(tab.id, setTimeout(() => { badgeTimers.delete(tab.id); chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}); }, 3000));
});

// Idle lock, scheduled by vault.js. The vault re-checks idle time on every read, so a late alarm is harmless.
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ff-lock') FFVault.lockNow(); });

// First install opens the setup screen. Updating from an unencrypted version opens it too, so the data gets encrypted.
chrome.runtime.onInstalled.addListener(async (d) => {
  if (d.reason === 'install' || (d.reason === 'update' && await FFVault.status() === 'legacy')) chrome.runtime.openOptionsPage();
});
