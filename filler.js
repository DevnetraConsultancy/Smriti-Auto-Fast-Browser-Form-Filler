/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
/*
 * formFillerMain(payload)
 * Injected into the page on demand via chrome.scripting.executeScript({ func }).
 * Must stay fully self-contained (it is serialised), so every helper lives inside.
 * Returns only counts and field labels, never the values that were filled.
 */
function formFillerMain(payload) {
  'use strict';
  const values = (payload && payload.values) || {};
  const customRules = (payload && payload.custom) || [];
  const opts = (payload && payload.options) || {};
  const overwrite = !!opts.overwrite;

  const result = { frame: window === window.top ? 'top' : 'frame', filled: 0, skippedExisting: 0, details: [], warnings: [], blocked: null, missed: [] };
  const clip = (t, n) => String(t || '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, n);
  const miss = (label, reason) => { if (result.missed.length < 20) result.missed.push({ label: clip(label, 40) || '(unnamed field)', reason }); };

  /* ---------- clobber-proof DOM access ----------
   * A form's named controls shadow its own properties, even in this isolated world: <input name="parentElement">
   * makes form.parentElement return that input, and <form name="querySelectorAll"> shadows the document's method.
   * Anything that can land on a form or the document goes through the prototypes instead. */
  const getter = (proto, key) => { const g = Object.getOwnPropertyDescriptor(proto, key).get; return (n) => g.call(n); };
  const nodeType = getter(Node.prototype, 'nodeType');
  const parentOf = getter(Node.prototype, 'parentElement');
  const kidsOf = getter(Node.prototype, 'childNodes');
  const textIn = getter(Node.prototype, 'textContent');
  const prevOf = getter(Element.prototype, 'previousElementSibling');
  const tagOf = getter(Element.prototype, 'tagName');
  const shadowOf = getter(Element.prototype, 'shadowRoot');
  const attr = (n, a) => Element.prototype.getAttribute.call(n, a);
  const rootOf = (n) => Node.prototype.getRootNode.call(n);
  const protoOf = (root) => { const k = nodeType(root); return k === 9 ? Document.prototype : k === 11 ? DocumentFragment.prototype : Element.prototype; };
  const qsa = (root, sel) => protoOf(root).querySelectorAll.call(root, sel);
  const hasFields = (n) => !!Element.prototype.querySelector.call(n, 'input,select,textarea');
  const byId = (root, id) => (nodeType(root) === 9 || nodeType(root) === 11 ? protoOf(root).getElementById.call(root, id) : null);
  const up = (n) => { const p = parentOf(n); if (p) return p; const r = rootOf(n); return nodeType(r) === 11 ? r.host : null; };

  /* ---------- page safety checks ---------- */
  // window.origin, not location: about:srcdoc and about:blank frames report protocol "about:" but inherit their parent's origin.
  const selfOrigin = window.origin || location.origin;
  let page = location;
  try { page = new URL(selfOrigin); } catch (e) { /* opaque origin */ }
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
  const insecurePage = page.protocol === 'http:' && !LOCAL.test(page.hostname);
  if (opts.blockInsecure && insecurePage) {
    result.blocked = 'insecure';
    return result;
  }
  // activeTab only reaches the tab's own origin. Refuse anything nested under another origin (A > B > A, sandboxed frames).
  const ancestors = location.ancestorOrigins;
  if (ancestors && Array.from(ancestors).some((o) => o !== selfOrigin)) {
    miss('(embedded frame)', 'frame from a different site, not filled');
    return result;
  }

  /* ---------- helpers ---------- */
  const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\[\]:#\/()*]+/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Anything matching these is NEVER filled, even by a custom rule. Checked per signal (name, id, each label).
  const HARD = /pass(word|wd|code)?\b|\bpwd\b|passwort|wachtwoord|contrase|senha|mot de passe|пароль|密码|密碼|パスワード|비밀번호|\bcvv\d?\b|\bcvc\d?\b|\bcsc\b|security code|card ?(number|num|no)\b|card ?holder|card ?expir|\bcc ?(num|number|exp)\b|\bcredit ?card\b|\bdebit ?card\b|\botp\b|one ?time|verification code|\b(2fa|mfa|tfa|totp)\b|\bauth(entication|orization)? ?code\b|recovery ?(code|key|phrase)|seed ?phrase|mnemonic|private ?key|api ?key|security (question|answer)|maiden name|\bssn\b|\bitin\b|\bnric\b|\bvoter ?id\b|social security|aadhaar|aadhar|\bpan\b|\biban\b|routing number|sort code|swift code|\bifsc\b|\bbsb\b|\bupi\b|\bbank ?account\b|account ?(number|no)\b|\bpin\b(?! ?code)|secret|token|captcha/;
  const DOC_ONLY = /^(passport|driving licen[cs]e|licen[cs]e|national id|tax id)( (no|number|num|id))?$/;
  const DOC_NUM = /(passport|licen[cs]e|national id|tax id) ?(no|number|num|id)\b|\b(no|number|num) (of )?(passport|licen[cs]e)/;
  const isSensitive = (sig) => HARD.test(sig) || DOC_ONLY.test(sig) || DOC_NUM.test(sig);
  const BAD_AC = /(^|\s)(cc-[a-z-]+|one-time-code|new-password|current-password|password)(\s|$)/;
  const SKIP_TYPES = new Set(['hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color', 'time', 'month', 'week', 'datetime-local']);
  const DATA_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-name', 'data-field', 'data-field-name', 'data-label', 'data-automation-id'];

  const RULES = [
    { key: 'linkedin', pats: [[/linkedin/, 80]] },
    { key: 'github', pats: [[/github/, 80]] },
    { key: 'email', ac: ['email'], types: ['email'], pats: [[/\be ?mail\b/, 55]] },
    { key: 'firstName', ac: ['given-name'], pats: [[/\b(first|given|fore) ?name\b/, 55], [/\bf ?name\b/, 45], [/^first$/, 40]] },
    { key: 'lastName', ac: ['family-name'], pats: [[/\b(last|family|sur) ?name\b/, 55], [/\bl ?name\b/, 45], [/^last$/, 40]] },
    { key: 'fullName', ac: ['name'], pats: [[/\b(full|your|complete|legal|applicant|candidate) ?name\b/, 55], [/^name$/, 50], [/\bname\b/, 30]],
      ex: /\b(first|last|given|family|sur|user|company|business|organi[sz]ation|file|nick|middle|display|account|card|bank|school|college|university|father|mother|spouse|parent|guardian|referr?er|reference|employer|manager|domain|host|project|team|street|city)\b/ },
    { key: 'username', ac: ['username'], pats: [[/\buser ?(name|id)\b/, 55], [/\blogin\b/, 35]] },
    { key: 'company', ac: ['organization'], pats: [[/\b(company|organi[sz]ation|employer|business)( name)?\b/, 50]], ex: /\b(web|site|url|e ?mail|phone|address)\b/ },
    { key: 'jobTitle', ac: ['organization-title'], pats: [[/\bjob ?title\b/, 55], [/\b(title|designation|position|occupation)\b/, 40]], ex: /\b(mr|mrs|salutation|page|document|project)\b/ },
    { key: 'website', ac: ['url'], types: ['url'], pats: [[/\b(web ?site|homepage|home page|portfolio|personal (site|url))\b/, 55], [/\burl\b/, 40]] },
    { key: 'phone', ac: ['tel', 'tel-national'], types: ['tel'], pats: [[/\b(phone|mobile|cell|telephone|whatsapp|contact (no|number)|tel)\b/, 55]], ex: /\b(country code|extension|ext|fax|dial)\b/ },
    { key: 'address2', ac: ['address-line2'], pats: [[/\b(address ?(line)? ?2|apt|apartment|suite|unit|flat|landmark)\b/, 55]] },
    { key: 'address1', ac: ['address-line1', 'street-address'], pats: [[/\b(address ?(line)? ?1?|street|addr)\b/, 50]],
      ex: /\b(e ?mail|line 2|address 2|apt|suite|unit|city|state|zip|postal|country|ip|web)\b/ },
    { key: 'city', ac: ['address-level2'], pats: [[/\b(city|town|locality)\b/, 55]] },
    { key: 'state', ac: ['address-level1'], pats: [[/\b(state|province|region|prefecture)\b/, 55]], ex: /\b(united|country|status)\b/ },
    { key: 'zip', ac: ['postal-code'], pats: [[/\b(zip|postal|post ?code|pin ?code|postcode)\b/, 55]] },
    { key: 'country', ac: ['country', 'country-name'], pats: [[/\bcountry\b/, 55]], ex: /\bcode\b/ },
    { key: 'dob', ac: ['bday'], pats: [[/\b(dob|birth ?day|birth ?date|date of birth|birth)\b/, 55]] },
  ];
  const customCompiled = customRules
    .filter((r) => r && r.match && r.value)
    .map((r) => ({
      value: String(r.value),
      res: String(r.match).split(',').map((k) => norm(k)).filter(Boolean).map((k) => new RegExp('(^|\\s)' + esc(k) + '(\\s|$)')),
    }))
    .filter((r) => r.res.length);

  const MAX_FIELDS = 5000; // a hostile page must not be able to stall the fill with millions of inputs
  function collect(root, out) {
    if (out.length >= MAX_FIELDS) return out;
    qsa(root, 'input,textarea,select').forEach((e) => out.push(e));
    qsa(root, '*').forEach((n) => { const sr = shadowOf(n); if (sr) collect(sr, out); });
    return out;
  }

  function labelTexts(el) {
    const out = [];
    try { if (el.labels) for (const l of el.labels) out.push(clip(l.textContent, 100)); } catch (e) { /* ignore */ }
    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const root = rootOf(el);
      lb.split(/\s+/).forEach((id) => {
        const n = byId(root, id);
        if (n) out.push(clip(textIn(n), 100));
      });
    }
    return out.filter(Boolean);
  }

  // Fallback for forms whose labels are not linked to inputs (plain div/span/td next to the field).
  function nearbyTexts(el) {
    const out = [];
    const textOf = (n) => (n && nodeType(n) === 1 && !/^(INPUT|SELECT|TEXTAREA|SCRIPT|STYLE|BUTTON)$/.test(tagOf(n)) && !hasFields(n)) ? clip(textIn(n), 61) : '';
    let node = el;
    for (let depth = 0; depth < 3 && node && !out.length; depth++) {
      let sib = prevOf(node);
      for (let hops = 0; sib && hops < 2; hops++, sib = prevOf(sib)) {
        // Never cross another form control: text beyond it belongs to that control, not this one.
        if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(tagOf(sib)) || hasFields(sib)) break;
        const t = textOf(sib); if (t && t.length <= 60) out.push(t);
      }
      const par = parentOf(node);
      if (!par || out.length) break;
      if (tagOf(par) === 'TD' || tagOf(par) === 'TH') { const t = textOf(prevOf(par)); if (t && t.length <= 60) out.push(t); }
      const own = clip(Array.from(kidsOf(par)).filter((n) => nodeType(n) === 3).map((n) => textIn(n)).join(' '), 61);
      if (own && own.length <= 60) out.push(own);
      node = par;
    }
    return out;
  }

  // Zero-area clip tricks. In-viewport fields are also caught by isCovered, because hit testing respects clipping.
  const CLIPPED = /^(inset\(\s*(4[5-9]|[5-9]\d|100)(\.\d+)?%|circle\(\s*0|ellipse\(\s*0)|^rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)/;

  // True when something unrelated sits on top of every sampled point of the field, or clipping removed it from hit testing.
  function isCovered(el, r, view) {
    const root = rootOf(el);
    const hitAt = (nodeType(root) === 11 ? ShadowRoot.prototype : Document.prototype).elementFromPoint || Document.prototype.elementFromPoint;
    let tested = 0;
    for (const fx of [0.5, 0.15, 0.85]) {
      const x = r.left + r.width * fx, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) continue;
      tested++;
      const hit = hitAt.call(root, x, y);
      if (!hit) continue;
      if (hit === el || Node.prototype.contains.call(hit, el) || Node.prototype.contains.call(el, hit)) return false;
      if (tagOf(hit) === 'LABEL' && hit.control === el) return false; // floating labels
    }
    return tested > 0;
  }

  function isVisible(el) {
    const view = el.ownerDocument.defaultView;
    const cs = view.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    const hasLayout = typeof el.checkVisibility === 'function';
    const rect = hasLayout ? el.getBoundingClientRect() : null;
    let opacity = 1;
    for (let n = el; n; n = up(n)) {
      if (nodeType(n) !== 1) continue;
      const s = view.getComputedStyle(n);
      if (s.display === 'none') return false;
      const o = parseFloat(s.opacity);
      if (!Number.isNaN(o)) opacity *= o;
      if (CLIPPED.test(String(s.clipPath)) || (s.position === 'absolute' && CLIPPED.test(String(s.clip)))) return false;
      // Scrollable panels are reachable, so only hidden/clip overflow counts as cutting the field off.
      if (rect && n !== el && /hidden|clip/.test(s.overflowX + ' ' + s.overflowY) && cs.position !== 'fixed') {
        const b = Element.prototype.getBoundingClientRect.call(n);
        if (Math.min(rect.right, b.right) - Math.max(rect.left, b.left) < 2 || Math.min(rect.bottom, b.bottom) - Math.max(rect.top, b.top) < 2) return false;
      }
    }
    if (opacity < 0.1) return false;
    if (hasLayout) {
      if (!el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
      if (rect.width < 6 || rect.height < 6) return false;                       // honeypot-sized
      if (rect.right + window.scrollX <= 0 || rect.bottom + window.scrollY <= 0) return false; // off-screen honeypot
      if (rect.left >= view.innerWidth) return false;                            // parked past the right edge
      if (isCovered(el, rect, view)) return false;
    }
    return true;
  }

  // A visible field inside an invisible iframe is still a trap, so the frame chain has to pass the same checks.
  function framesVisible() {
    try {
      for (let w = window; w !== w.top; w = w.parent) {
        const f = w.frameElement;
        if (!f || !isVisible(f)) return false;
      }
      return true;
    } catch (e) { return false; }
  }

  function isEmpty(el) {
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return el.selectedIndex <= 0 || !o || o.value === '' || o.disabled;
    }
    return el.value === '';
  }

  function setValue(el, v) {
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, v); // native setter so React/Vue/Angular notice the change
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  function formatDate(el, iso, hints) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    if (el.type === 'date') return iso;
    const h = hints.join(' ').toLowerCase();
    const sep = h.includes('/') ? '/' : h.includes('-') ? '-' : h.includes('.') ? '.' : '/';
    if (/d{1,2}\W{0,3}m{1,2}/.test(h)) return [m[3], m[2], m[1]].join(sep);
    if (/m{1,2}\W{0,3}d{1,2}/.test(h)) return [m[2], m[3], m[1]].join(sep);
    if (/y{2,4}\W{0,3}m/.test(h)) return [m[1], m[2], m[3]].join(sep);
    return iso;
  }

  function fillSelect(el, v) {
    const want = norm(v);
    if (!want) return false;
    const opts2 = Array.from(el.options).filter((o) => !o.disabled && o.value !== '');
    const text = (o) => norm(o.textContent);
    let hit = opts2.find((o) => norm(o.value) === want || text(o) === want)
      || opts2.find((o) => text(o).startsWith(want) || (want.length >= 3 && want.startsWith(text(o)) && text(o).length >= 3))
      || (want.length >= 3 ? opts2.find((o) => text(o).includes(want)) : null);
    if (!hit) return false;
    setValue(el, hit.value);
    return true;
  }

  /* ---------- main ---------- */
  const seen = new Set();
  const origins = new Set();
  const insecureTargets = new Set();
  const checkedForms = new Set();
  if (!framesVisible()) {
    miss('(embedded frame)', 'frame is hidden or off-screen (treated as a trap)');
    return result;
  }
  const elements = collect(document, []).slice(0, MAX_FIELDS);

  // Reads the attributes, not form.action: <input name="action"> would clobber it and silence the warning.
  function noteTargets(el) {
    const form = el.form;
    if (!form || checkedForms.has(form)) return;
    checkedForms.add(form);
    const targets = [attr(form, 'action')];
    qsa(rootOf(form), '[formaction]').forEach((b) => { if (b.form === form) targets.push(attr(b, 'formaction')); });
    targets.forEach((t) => {
      if (!t) return;
      try {
        const u = new URL(t, el.baseURI); // baseURI, so a planted <base href> cannot disguise the destination
        if (u.protocol === 'javascript:') return;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') origins.add(u.protocol);
        else if (u.host !== page.host) origins.add(u.host);
        if (u.protocol === 'http:' && !insecurePage && !LOCAL.test(u.hostname)) insecureTargets.add(u.host);
      } catch (e) { /* ignore */ }
    });
  }

  for (const el of elements) {
    if (seen.has(el)) continue;
    seen.add(el);

    const tag = el.tagName;
    const type = tag === 'INPUT' ? (attr(el, 'type') || 'text').toLowerCase() : 'text';
    if (tag === 'INPUT' && type !== 'password' && SKIP_TYPES.has(type)) continue;

    const acRaw = (attr(el, 'autocomplete') || '').toLowerCase();
    const acTokens = acRaw.split(/\s+/).filter((t) => t && t !== 'on' && t !== 'off');

    const nameSigs = [attr(el, 'name'), el.id].concat(DATA_ATTRS.map((a) => attr(el, a))).map(norm).filter(Boolean);
    const labels = labelTexts(el);
    const labelSigs = [attr(el, 'placeholder'), attr(el, 'aria-label'), attr(el, 'title')].concat(labels).map(norm).filter(Boolean);
    const near = labelSigs.length && labels.length ? [] : nearbyTexts(el);
    const nearSigs = near.map(norm).filter(Boolean);
    const allSigs = nameSigs.concat(labelSigs, nearSigs);
    const shown = labels[0] || near[0] || attr(el, 'aria-label') || attr(el, 'placeholder') || attr(el, 'name') || el.id || '';

    if (type === 'password' || BAD_AC.test(acRaw) || allSigs.some(isSensitive) || isSensitive(acRaw)) { miss(shown, 'sensitive field, never filled'); continue; }
    if (el.disabled || el.readOnly) { miss(shown, 'read-only or disabled'); continue; }
    if (!isVisible(el)) { miss(shown, 'hidden or off-screen, or covered (treated as a trap)'); continue; }

    let best = null, bestAny = null;

    for (const c of customCompiled) {
      if (c.res.some((re) => allSigs.some((s2) => re.test(s2)))) { best = { score: 110, key: 'custom', value: c.value }; break; }
    }

    if (!best) {
      for (const rule of RULES) {
        let s2 = 0;
        if (rule.ac && acTokens.some((t) => rule.ac.includes(t))) s2 = 100;
        else if (rule.types && rule.types.includes(type)) s2 = 70;
        if (type === 'date' && rule.key === 'dob') s2 = Math.max(s2, 60);
        const hit = (sigs, re) => sigs.some((x) => re.test(x) && !(rule.ex && rule.ex.test(x)));
        for (const [re, w] of rule.pats) {
          // What the person sees (label, placeholder) outranks developer names; nearby text ranks lowest.
          if (hit(labelSigs, re)) s2 = Math.max(s2, w);
          else if (hit(nameSigs, re)) s2 = Math.max(s2, w - 5);
          else if (hit(nearSigs, re)) s2 = Math.max(s2, w - 10);
        }
        if (s2 < 20) continue;
        if (!bestAny || s2 > bestAny.score) bestAny = { score: s2, key: rule.key };
        if (values[rule.key] && (!best || s2 > best.score)) best = { score: s2, key: rule.key, value: values[rule.key] };
      }
    }
    if (!best) {
      if (!isEmpty(el)) continue; // already has text and nothing to say about it
      if (bestAny && !values[bestAny.key]) miss(shown, 'looks like "' + bestAny.key + '" but that is empty in your profile');
      else miss(shown, 'no profile field matches this label');
      continue;
    }

    if (!overwrite && !isEmpty(el)) { result.skippedExisting++; continue; }

    let v = best.value;
    if (best.key === 'dob') v = formatDate(el, v, [attr(el, 'placeholder') || '', labels.join(' ')]);
    if (type === 'number' && !/^\d+$/.test(v)) { miss(shown, 'number field needs digits only'); continue; }
    if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { miss(shown, 'date must be YYYY-MM-DD'); continue; }

    let ok = true;
    if (tag === 'SELECT') ok = fillSelect(el, v);
    else setValue(el, v);
    if (!ok) { miss(shown, 'dropdown has no option matching your value'); continue; }

    result.filled++;
    if (result.details.length < 200) result.details.push({ key: best.key, label: clip(shown, 40).replace(/[*:]+$/, '').trim() || best.key });
    noteTargets(el);
  }

  if (origins.size) result.warnings.push('Some filled forms submit to a different site: ' + Array.from(origins).join(', '));
  if (insecureTargets.size) result.warnings.push('Some filled forms submit without encryption to: ' + Array.from(insecureTargets).join(', '));
  if (insecurePage) result.warnings.push('This page is not using HTTPS.');
  return result;
}
