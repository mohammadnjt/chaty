// A message's text: plain with links made clickable, or, when it's written
// in Markdown (pasted from an AI chat), formatted. The Markdown renderer is a
// separate chunk, fetched in the background once the app is idle.
import { lazy, Suspense } from 'react';
import { looksLikeMarkdown } from '../lib/markdown';

const loadMarkdown = () => import('./Markdown');
const Markdown = lazy(loadMarkdown);
if ('requestIdleCallback' in window) requestIdleCallback(() => void loadMarkdown());
else setTimeout(() => void loadMarkdown(), 3000);

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

export default function RichText({ text }: { text: string }) {
  if (!looksLikeMarkdown(text)) return <Linkified text={text} />;
  return (
    <Suspense fallback={<Linkified text={text} />}>
      <Markdown text={text} />
    </Suspense>
  );
}
