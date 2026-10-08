import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';
import './landing.css';

// Old links to the app (/#/chat/12) now live under /app/.
if (location.hash.startsWith('#/')) location.replace('/app/' + location.hash);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
