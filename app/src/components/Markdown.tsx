// Markdown in a message bubble: bold, lists, tables, code and the rest, as
// AI chats write it. Built from marked's tokens into React elements, so no
// HTML from a message ever reaches the page (HTML shows as text), and links
// open only for http(s), mailto and tel. Loaded only once a message needs it
// (see RichText).
import { Check, Copy } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { copyText } from '../lib/format';

const SAFE_URL = /^(https?:|mailto:|tel:)/i;
const stop = (e: React.MouseEvent) => e.stopPropagation();

function inline(tokens: Token[] | undefined, key: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'strong':
        return <strong key={k}>{inline(t.tokens, k)}</strong>;
      case 'em':
        return <em key={k}>{inline(t.tokens, k)}</em>;
      case 'del':
        return <del key={k}>{inline(t.tokens, k)}</del>;
      case 'codespan':
        return <code key={k}>{t.text}</code>;
      case 'br':
        return <br key={k} />;
      case 'link':
      case 'image': // pictures from elsewhere aren't loaded; they show as a link
        return SAFE_URL.test(t.href) ? (
          <a key={k} href={t.href} target="_blank" rel="noreferrer" onClick={stop}>
            {t.type === 'link' ? inline(t.tokens, k) : t.text || t.href}
          </a>
        ) : (
          <Fragment key={k}>{t.text}</Fragment>
        );
      case 'text':
        return <Fragment key={k}>{t.tokens ? inline(t.tokens, k) : t.text}</Fragment>;
      default: // escape, html (shown as text), anything newer
        return <Fragment key={k}>{'text' in t ? t.text : t.raw}</Fragment>;
    }
  });
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (await copyText(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span>{lang || 'code'}</span>
        <button onClick={copy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre dir="ltr">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const ALIGN = { left: 'start', center: 'center', right: 'end' } as const;

function Table({ t, k }: { t: Tokens.Table; k: string }) {
  const align = (i: number) => (t.align[i] ? { textAlign: ALIGN[t.align[i]!] } : undefined);
  return (
    <div className="md-table">
      <table dir="auto">
        <thead>
          <tr>
            {t.header.map((c, i) => (
              <th key={i} style={align(i)}>
                {inline(c.tokens, `${k}.h${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i} style={align(i)}>
                  {inline(c.tokens, `${k}.${r}.${i}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Blocks; in a tight list item, its text runs inline instead of as paragraphs. */
function blocks(tokens: Token[], key: string, tight = false): ReactNode[] {
  return tokens.map((t, i) => {
    const k = `${key}.${i}`;
    switch (t.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        return (
          <div key={k} className={`md-h md-h${Math.min(t.depth, 3)}`} dir="auto">
            {inline(t.tokens, k)}
          </div>
        );
      case 'paragraph':
        return (
          <p key={k} dir="auto">
            {inline(t.tokens, k)}
          </p>
        );
      case 'text':
        return tight ? (
          <Fragment key={k}>{t.tokens ? inline(t.tokens, k) : t.text}</Fragment>
        ) : (
          <p key={k} dir="auto">
            {t.tokens ? inline(t.tokens, k) : t.text}
          </p>
        );
      case 'blockquote':
        return (
          <blockquote key={k} dir="auto">
            {blocks(t.tokens ?? [], k)}
          </blockquote>
        );
      case 'list': {
        const List = t.ordered ? 'ol' : 'ul';
        return (
          <List key={k} dir="auto" start={t.ordered && t.start !== 1 && t.start !== '' ? Number(t.start) : undefined}>
            {(t as Tokens.List).items.map((item, j) => (
              <li key={j} dir="auto">
                {item.task && <span className="md-task">{item.checked ? '☑' : '☐'} </span>}
                {blocks(item.tokens, `${k}.${j}`, !item.loose)}
              </li>
            ))}
          </List>
        );
      }
      case 'code':
        return <CodeBlock key={k} code={t.text} lang={t.lang} />;
      case 'table':
        return <Table key={k} t={t as Tokens.Table} k={k} />;
      case 'hr':
        return <hr key={k} />;
      default: // html (shown as text) and anything newer
        return (
          <p key={k} dir="auto">
            {t.raw}
          </p>
        );
    }
  });
}

export default function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => Lexer.lex(text, { gfm: true, breaks: true }), [text]);
  return <div className="md">{blocks(tokens, 'b')}</div>;
}
