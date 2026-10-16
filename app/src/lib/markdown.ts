// Text pasted from an AI chat is Markdown: **bold**, lists, tables, code.
// These helpers are cheap and don't load the Markdown renderer
// (components/Markdown.tsx), which only messages that need it use.

/** The most a text message can hold (the server's limit, in characters). */
export const MAX_TEXT = 4000;

const SIGNS = [
  /\*\*[^*\n]+\*\*/, // **bold**
  /__[^_\n]+__/, // __bold__
  /~~[^~\n]+~~/, // ~~struck~~
  /(^|\s)\*[^*\s][^*\n]*\*(?=$|[\s.,!?:;])/m, // *italic*
  /`[^`\n]+`/, // `code`
  /^\s*(```|~~~)/m, // code block
  /^\s{0,3}#{1,6}\s+\S/m, // # heading
  /^\s*[-*+]\s+\S/m, // - list
  /^\s*\d{1,3}[.)]\s+\S/m, // 1. list
  /^\s{0,3}>\s?\S/m, // > quote
  /^.*\|.*\n\s*\|?\s*:?-{3,}:?\s*(\||$)/m, // table: a header and its |---| line
  /\[[^\]\n]+\]\((https?:|mailto:|tel:)[^)\s]+\)/, // [link](https://…)
  /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/m, // --- rule
];

/** Whether the text uses Markdown at all; plain messages skip the renderer. */
export function looksLikeMarkdown(text: string): boolean {
  return SIGNS.some((re) => re.test(text));
}

/** The text without Markdown signs, for one-line previews and notifications. */
export function plainText(text: string): string {
  if (!looksLikeMarkdown(text)) return text;
  return text
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+\[([ xX])\][ \t]*/gm, (_, x: string) => (x === ' ' ? '☐ ' : '☑ '))
    .replace(/^[ \t]*(```|~~~).*$/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).join(' · '))
    .replace(/^[ \t]{0,3}(#{1,6}|>)[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------- long messages ----------

interface Block {
  kind: 'code' | 'table' | 'text';
  lines: string[];
}

const FENCE = /^[ \t]*(```|~~~)/;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/;

/** Code blocks, tables and paragraphs (separated by blank lines). */
function toBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) out.push({ kind: 'text', lines: para });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endPara();
      const fence = line.trim().slice(0, 3);
      const block: Block = { kind: 'code', lines: [line] };
      while (++i < lines.length) {
        block.lines.push(lines[i]);
        if (lines[i].trim().startsWith(fence)) break;
      }
      out.push(block);
    } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '')) {
      endPara();
      const block: Block = { kind: 'table', lines: [line, lines[++i]] };
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) block.lines.push(lines[++i]);
      out.push(block);
    } else if (!line.trim()) {
      endPara();
    } else {
      para.push(line);
    }
  }
  endPara();
  return out;
}

/** A line longer than max, cut after a sentence or a word (or anywhere, as a last resort). */
function cutLine(line: string, max: number): string[] {
  const out: string[] = [];
  while (line.length > max) {
    const part = line.slice(0, max);
    let at = Math.max(...['. ', '! ', '? ', '؟ ', '。'].map((end) => part.lastIndexOf(end)));
    if (at < max / 2) at = part.lastIndexOf(' ');
    if (at < max / 2) at = /[\ud800-\udbff]/.test(part[max - 2]) ? max - 3 : max - 2; // don't split an emoji
    out.push(line.slice(0, at + 1).trimEnd());
    line = line.slice(at + 1).trimStart();
  }
  out.push(line);
  return out;
}

/** Lines joined into pieces of at most max characters. */
function packLines(lines: string[], max: number): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of lines.flatMap((l) => cutLine(l, max))) {
    if (cur !== null && cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur === null ? line : `${cur}\n${line}`;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** A block in pieces that fit; a code block keeps its fences and a table its header in every piece. */
function pieces(b: Block, max: number): string[] {
  const whole = b.lines.join('\n');
  if (whole.length <= max) return [whole];
  if (b.kind === 'code') {
    const open = b.lines[0];
    const closed = b.lines.length > 1 && FENCE.test(b.lines[b.lines.length - 1]);
    const close = closed ? b.lines[b.lines.length - 1] : open.trim().slice(0, 3);
    const body = b.lines.slice(1, closed ? -1 : undefined);
    return packLines(body, max - open.length - close.length - 2).map((p) => `${open}\n${p}\n${close}`);
  }
  if (b.kind === 'table') {
    const head = b.lines.slice(0, 2).join('\n');
    return packLines(b.lines.slice(2), max - head.length - 1).map((p) => `${head}\n${p}`);
  }
  return packLines(b.lines, max);
}

/**
 * A text too long for one message, as several (like Telegram), split
 * between paragraphs where possible. Code blocks and tables cut in two stay
 * code blocks and tables in each message.
 */
export function splitLongText(text: string, max = MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const block of toBlocks(text)) {
    for (const piece of pieces(block, max)) {
      if (cur && cur.length + 2 + piece.length > max) {
        out.push(cur);
        cur = piece;
      } else {
        cur = cur ? `${cur}\n\n${piece}` : piece;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}
