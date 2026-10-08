import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { isNativeShell } from './lib/config';
import './styles.css';

// Installable web app (PWA). The Android app ships its files itself.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNativeShell) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
