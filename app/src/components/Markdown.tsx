// Markdown in a message bubble: bold, lists, tables, code and the rest, as
// AI chats write it. Checklists ("- [ ] …") can be ticked by anyone in the
// chat; next to an item someone other than its writer ticked, their photo. Built from marked's tokens into React elements, so no
// HTML from a message ever reaches the page (HTML shows as text), and links
// open only for http(s), mailto and tel. Loaded only once a message needs it
// (see RichText).
import { Check, Copy } from 'lucide-react';
import { createContext, Fragment, useContext, useMemo, useState, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { copyText } from '../lib/format';
import type { Message, User } from '../lib/types';
import Avatar from './Avatar';

/** A message's checklist: who wrote it, how people left its items, and how to tick one. */
export interface Checklist {
  checks?: Message['checks'];
  author: number;
  who?: (id: number) => User | undefined;
  /** Absent while the message can't be changed (still sending, deleted). */
  onToggle?: (item: number, on: boolean) => void;
}

const ChecklistContext = createContext<{ list?: Checklist; index: Map<Tokens.ListItem, number> }>({ index: new Map() });

/** Numbers the checklist items in reading order, as the server counts them. */
function numberTasks(tokens: Token[], index: Map<Tokens.ListItem, number>) {
  for (const t of tokens) {
    if (t.type === 'list') {
      for (const item of (t as Tokens.List).items) {
        if (item.task) index.set(item, index.size);
        numberTasks(item.tokens, index);
      }
    } else if (t.type === 'blockquote') {
      numberTasks(t.tokens ?? [], index);
    }
  }
}

/** A checklist item: its box, the photo of whoever else ticked it, its text (struck when ticked) and any sub-list. */
function TaskItem({ item, k }: { item: Tokens.ListItem; k: string }) {
  const { list, index } = useContext(ChecklistContext);
  const n = index.get(item) ?? -1;
  const mark = list?.checks?.[n];
  const on = mark ? mark.on : !!item.checked;
  const by = mark ? (mark.on ? mark.by : 0) : item.checked ? list?.author : 0;
  const other = on && by && list && by !== list.author ? list.who?.(by) : undefined;
  const toggle = n >= 0 ? list?.onToggle : undefined;
  const nested = item.tokens.filter((t) => t.type === 'list');
  return (
    <li className={`md-task ${on ? 'on' : ''}`}>
      <div className="md-task-row">
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          className="md-check"
          disabled={!toggle}
          onClick={(e) => {
            e.stopPropagation();
            toggle?.(n, !on);
          }}
        >
          {on && <Check size={12} strokeWidth={3.5} />}
        </button>
        {other && (
          <span className="md-check-by" title={`Ticked by ${other.name}`}>
            <Avatar name={other.name} src={other.avatar} size={18} ring={false} />
          </span>
        )}
        <div className="md-task-text" dir="auto">
          {blocks(item.tokens.filter((t) => t.type !== 'list'), k, !item.loose)}
        </div>
      </div>
      {nested.length > 0 && blocks(nested, `${k}.sub`)}
    </li>
  );
}

// A list or quote takes the direction of its text, and its items follow it.
// (dir="auto" can't do this: it skips children that have a dir of their own,
// and so leaves a Persian list's indent on the wrong side.)
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LTR = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/;
function dirOf(raw: string): 'rtl' | 'ltr' {
  for (const ch of raw.replace(/\[[ xX]\]|\]\([^)]*\)|`[^`]*`/g, '')) {
    if (RTL.test(ch)) return 'rtl';
    if (LTR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

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
      case 'checkbox': // a checklist item's box: TaskItem draws it
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
          <blockquote key={k} dir={dirOf(t.raw)}>
            {blocks(t.tokens ?? [], k)}
          </blockquote>
        );
      case 'list': {
        const List = t.ordered ? 'ol' : 'ul';
        return (
          <List key={k} dir={dirOf(t.raw)} start={t.ordered && t.start !== 1 && t.start !== '' ? Number(t.start) : undefined}>
            {(t as Tokens.List).items.map((item, j) =>
              item.task ? (
                <TaskItem key={j} item={item} k={`${k}.${j}`} />
              ) : (
                <li key={j}>{blocks(item.tokens, `${k}.${j}`, !item.loose)}</li>
              ),
            )}
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

export default function Markdown({ text, checklist }: { text: string; checklist?: Checklist }) {
  const { tokens, index } = useMemo(() => {
    const tokens = Lexer.lex(text, { gfm: true, breaks: true });
    const index = new Map<Tokens.ListItem, number>();
    numberTasks(tokens, index);
    return { tokens, index };
  }, [text]);
  return (
    <ChecklistContext.Provider value={{ list: checklist, index }}>
      <div className="md">{blocks(tokens, 'b')}</div>
    </ChecklistContext.Provider>
  );
}
