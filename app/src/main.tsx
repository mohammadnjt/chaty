import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { isNativeShell } from './lib/config';
import './styles.css';

// Installable web app (PWA). The Android app ships its files itself.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeShell) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped notification opens its chat in this window.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open') location.hash = new URL(e.data.url, location.origin).hash;
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
