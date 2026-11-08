/*! Smriti: Private Form Filler. Copyright (c) 2026 Devnetra Consultancy (devnetraconsultancy@gmail.com). All rights reserved. Proprietary software: copying, modifying or redistributing any part without written permission is prohibited. See LICENSE. */
/*
 * Minimal, dependency-free .xlsx reader, kept only to import unencrypted exports from earlier versions.
 * Handles files written by Form Filler 1.x/2.0 and files re-saved by Excel, LibreOffice or Google Sheets.
 */
(function () {
  const dec = new TextDecoder();
  const MAX_UNZIPPED = 5 * 1024 * 1024, MAX_ENTRIES = 512;

  /* ---------- reader ---------- */
  // Counts real output as it streams and stops at the budget, so a zip bomb cannot exhaust memory first.
  async function inflateRaw(bytes, budget) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > budget) { await reader.cancel().catch(() => {}); throw new Error('File too large'); }
      chunks.push(value);
    }
    const out = new Uint8Array(size); let o = 0;
    chunks.forEach((c) => { out.set(c, o); o += c.length; });
    return out;
  }

  async function unzip(buffer) {
    const b = new Uint8Array(buffer), dv = new DataView(buffer);
    let e = b.length - 22; const stop = Math.max(0, e - 65535); // the zip comment is at most 64 KB
    while (e >= stop && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < stop) throw new Error('Not a valid .xlsx file');
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    if (count > MAX_ENTRIES) throw new Error('File too large');
    const files = Object.create(null); let total = 0;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!/\.(xml|rels)$/.test(name)) continue;
      if (flags & 1) throw new Error('Password-protected workbooks are not supported');
      if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('Corrupt zip');
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const raw = b.subarray(start, start + csize);
      if (method !== 0 && method !== 8) throw new Error('Unsupported compression');
      // Sizes declared in the zip can lie, so the budget tracks the bytes actually produced.
      const data = method === 0 ? raw : await inflateRaw(raw, MAX_UNZIPPED - total);
      total += data.length;
      if (total > MAX_UNZIPPED) throw new Error('File too large');
      files[name] = data;
    }
    return files;
  }

  // Trusted Types: DOMParser is a sink. The parsed XML is only ever read, never attached to the page.
  const xmlPolicy = globalThis.trustedTypes ? globalThis.trustedTypes.createPolicy('ffxml', { createHTML: (s) => s }) : null;
  const parseXml = (bytes) => {
    const text = dec.decode(bytes);
    if (/<!(DOCTYPE|ENTITY)/i.test(text)) throw new Error('This workbook contains unsupported XML'); // blocks entity-expansion bombs
    const d = new DOMParser().parseFromString(xmlPolicy ? xmlPolicy.createHTML(text) : text, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('Corrupt XML');
    return d;
  };
  const byLocal = (node, name) => Array.from(node.getElementsByTagName('*')).filter((n) => n.localName === name);
  const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const textOf = (node) => byLocal(node, 't').map((t) => t.textContent).join('');

  // -> { sheetName: string[][] }
  async function parse(buffer) {
    const files = await unzip(buffer);
    if (!files['xl/workbook.xml']) throw new Error('Not an Excel workbook');
    const wb = parseXml(files['xl/workbook.xml']);
    const rels = Object.create(null);
    byLocal(parseXml(files['xl/_rels/workbook.xml.rels']), 'Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const shared = files['xl/sharedStrings.xml'] ? byLocal(parseXml(files['xl/sharedStrings.xml']), 'si').map(textOf) : [];
    const out = Object.create(null);
    for (const s of byLocal(wb, 'sheet')) {
      const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
      let target = (rels[rid] || '').replace(/^\//, ''); if (!target.startsWith('xl/')) target = 'xl/' + target;
      if (!files[target]) continue;
      const rows = [];
      byLocal(parseXml(files[target]), 'row').forEach((row, ri) => {
        const idx = row.getAttribute('r') ? parseInt(row.getAttribute('r'), 10) - 1 : ri;
        if (idx > 5000) return;
        const cells = [];
        Array.from(row.children).forEach((c) => {
          if (c.localName !== 'c') return;
          const t = c.getAttribute('t'), vEl = Array.from(c.children).find((x) => x.localName === 'v');
          let val = '';
          if (t === 'inlineStr') val = textOf(c);
          else if (t === 's' && vEl) val = shared[parseInt(vEl.textContent, 10)] || '';
          else if (vEl) val = vEl.textContent;
          const ci = c.getAttribute('r') ? colIndex(c.getAttribute('r')) : cells.length;
          if (ci < 26) cells[ci] = val;
        });
        rows[idx] = Array.from(cells, (v) => (v == null ? '' : String(v)));
      });
      out[s.getAttribute('name')] = Array.from(rows, (r) => r || []);
    }
    return out;
  }

  globalThis.FFXlsx = { parse };
})();
