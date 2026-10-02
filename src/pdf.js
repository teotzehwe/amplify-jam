/**
 * Tiny multi-page PDF writer. Helvetica only, no dependencies.
 *
 * Good enough for a night-of host report. Names outside Latin-1 are
 * approximated (accents stripped) so the file stays self-contained.
 */

const PAGE_W = 612; // US Letter
const PAGE_H = 792;
const MARGIN = 48;
const LINE = 13;
const TITLE_SIZE = 16;
const BODY_SIZE = 10;
const SMALL_SIZE = 9;

/** Strip combining marks and drop anything Helvetica cannot draw. */
export function pdfText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrap(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const next = `${cur} ${words[i]}`;
    if (next.length <= maxChars) cur = next;
    else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * @param {{ title?: string, subtitle?: string, sections: { heading: string, lines: string[] }[] }} report
 * @returns {Buffer}
 */
export function buildPdf(report) {
  const pages = [];
  let page = [];
  let y = PAGE_H - MARGIN;
  const maxChars = 92;

  const newPage = () => {
    pages.push(page);
    page = [];
    y = PAGE_H - MARGIN;
  };

  const ensure = (need = LINE) => {
    if (y - need < MARGIN) newPage();
  };

  const addLine = (text, { size = BODY_SIZE, gap = LINE, indent = 0 } = {}) => {
    for (const part of wrap(text, maxChars - Math.floor(indent / 5))) {
      ensure(gap);
      page.push({ text: part, size, x: MARGIN + indent, y });
      y -= gap;
    }
  };

  if (report.title) {
    addLine(report.title, { size: TITLE_SIZE, gap: 20 });
  }
  if (report.subtitle) {
    addLine(report.subtitle, { size: SMALL_SIZE, gap: 16 });
  }

  for (const section of report.sections || []) {
    y -= 6;
    ensure(LINE * 2);
    addLine(section.heading, { size: 12, gap: 16 });
    const rows = section.lines?.length ? section.lines : ['—'];
    for (const row of rows) {
      addLine(row, { size: BODY_SIZE, gap: LINE, indent: 10 });
    }
  }

  if (page.length) pages.push(page);
  if (!pages.length) pages.push([{ text: 'Empty report', size: BODY_SIZE, x: MARGIN, y: PAGE_H - MARGIN }]);

  return assemble(pages);
}

function assemble(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];

  for (const lines of pages) {
    const ops = ['BT'];
    let lastSize = null;
    for (const line of lines) {
      if (line.size !== lastSize) {
        ops.push(`/F1 ${line.size} Tf`);
        lastSize = line.size;
      }
      // Absolute position each line (Td is relative; Tm is absolute).
      ops.push(`1 0 0 1 ${line.x.toFixed(2)} ${line.y.toFixed(2)} Tm (${pdfText(line.text)}) Tj`);
    }
    ops.push('ET');
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageId = add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
      + `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = add(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`);
  // Patch Parent references now that pagesId is known.
  for (const id of pageIds) {
    objects[id - 1] = objects[id - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  out += `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'utf8');
}
