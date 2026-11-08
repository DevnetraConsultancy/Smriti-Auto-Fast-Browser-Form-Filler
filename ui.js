/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
/* Small DOM helpers shared by the popup and options page. Everything is built with text nodes, never HTML strings. */
(function () {
  const ICONS = {
    lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z',
    warn: 'M8 2 15 14H1zM8 6.5v3.5M8 12v.01',
    check: 'M3 8.5 6.5 12 13 4.5',
    plus: 'M8 3v10M3 8h10',
    trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
    copy: 'M6 6h7.5v7.5H6zM3 10V2.5h7.5',
    gear: 'M2 5h7M12 5h2M2 11h2M7 11h7M9 3.5h3v3H9zM4 9.5h3v3H4z',
    x: 'M4 4l8 8M12 4l-8 8',
    mail: 'M2 3.5h12v9H2zM2.5 4l5.5 4.5L13.5 4',
    folder: 'M2 4.5V12.5h12V5.5H7.5L6 4H2.5z',
    heart:'M8 13.5S2 9.8 2 5.9A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 6 1.3c0 3.9-6 7.6-6 7.6z',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    kids.forEach((k) => { if (k != null) n.append(k); });
    return n;
  }

  // "Asha Rao" -> "AR", "Personal" -> "P". Array.from keeps emoji and non-Latin initials whole.
  function monogram(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('') || '?';
  }

  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function summary(p) {
    const fields = Object.keys(p.values).length, rules = p.custom.length;
    if (!fields && !rules) return 'No details yet';
    return plural(fields, 'detail') + (rules ? ', ' + plural(rules, 'custom rule') : '');
  }

  globalThis.FFUI = { icon, el, monogram, plural, summary };
})();
