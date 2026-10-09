import {
  ArrowRight,
  Download,
  Eye,
  Globe,
  Heart,
  Image,
  Lock,
  Menu,
  MessagesSquare,
  Server,
  ShieldCheck,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import Logo from '../components/Logo';
import Scenery from '../components/Scenery';
import { formatBytes } from '../lib/format';

interface AndroidApp {
  url: string;
  size: number;
  version: string;
  updatedAt: number;
}

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

const APP_URL = '/app/';

function AndroidIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.637.637 0 00-.83.22l-1.88 3.24a11.43 11.43 0 00-8.94 0L5.65 5.67a.643.643 0 00-.87-.2c-.28.18-.37.54-.22.83L6.4 9.48A10.78 10.78 0 001 18h22a10.78 10.78 0 00-5.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
    </svg>
  );
}

function StatusIcons() {
  return (
    <svg width="44" height="11" viewBox="0 0 44 11" fill="currentColor" aria-hidden="true">
      <rect x="0" y="7" width="2.4" height="4" rx="0.6" />
      <rect x="3.6" y="5" width="2.4" height="6" rx="0.6" />
      <rect x="7.2" y="3" width="2.4" height="8" rx="0.6" />
      <rect x="10.8" y="1" width="2.4" height="10" rx="0.6" />
      <path d="M21 3.2a8 8 0 0110 0l-1.2 1.4a6 6 0 00-7.6 0zM23.1 5.7a4.6 4.6 0 015.8 0L26 9z" />
      <rect x="34" y="1.5" width="8.5" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect x="35.4" y="2.9" width="5.7" height="5.2" rx="1" />
      <rect x="43" y="4" width="1" height="3" rx="0.5" />
    </svg>
  );
}

/** The app's sign-in screen, drawn inside a tilted phone. */
function PhoneMockup() {
  return (
    <div className="lp-phone-wrap" aria-hidden="true">
      <div className="lp-phone">
        <div className="lp-screen">
          <Scenery variant="full" className="lp-screen-bg" />
          <div className="lp-status">
            <span>9:41</span>
            <span className="lp-notch" />
            <StatusIcons />
          </div>
          <div className="lp-screen-body">
            <Logo size={46} />
            <h3>Chaty</h3>
            <p>Messages, voice and video calls under a calm night sky.</p>
            <div className="lp-card">
              <div className="lp-seg">
                <span className="on">Sign in</span>
                <span>Create account</span>
              </div>
              <div className="lp-field">Phone number, e.g. 0912 345 6789</div>
              <div className="lp-field">
                Password <Eye size={13} />
              </div>
              <div className="lp-btn">Sign in</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const FEATURES = [
  {
    Icon: Video,
    title: 'Voice & video calls',
    text: 'Clear one-to-one calls. When a network blocks call traffic, Chaty switches to a secure relay through your server, so the call keeps going.',
  },
  {
    Icon: MessagesSquare,
    title: 'Chats that feel familiar',
    text: 'Reply, edit, react, pin and forward messages, with typing indicators and read receipts.',
  },
  {
    Icon: Image,
    title: 'Photos, files & voice notes',
    text: 'Paste a screenshot, drop in a file or record a voice message: it arrives in a moment.',
  },
  { Icon: Users, title: 'Groups', text: 'Bring family, friends or your team together in one conversation.' },
  {
    Icon: ShieldCheck,
    title: 'Private by default',
    text: 'Only people with your number or ID can find you. Block anyone and hide your last seen.',
  },
  {
    Icon: Server,
    title: 'Your own server',
    text: 'Chaty runs on your server, so your conversations and files stay with you.',
  },
];

export default function Landing() {
  const [android, setAndroid] = useState<AndroidApp | null | undefined>(undefined);
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState('home');
  const [scrolled, setScrolled] = useState(false);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    fetch('/api/public-config')
      .then((r) => r.json())
      .then((c) => setAndroid(c.android ?? null))
      .catch(() => setAndroid(null));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Underline the section you're looking at.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    ['home', 'features', 'about', 'download'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  async function installApp() {
    if (!install) return;
    await install.prompt();
    setInstall(null);
  }

  const androidMeta = android
    ? [android.version && `v${android.version}`, formatBytes(android.size)].filter(Boolean).join(' · ')
    : '';

  const nav = [
    ['home', 'Home'],
    ['features', 'Features'],
    ['about', 'About'],
    ['download', 'Download'],
  ];

  return (
    <div className="lp">
      <header className={`lp-header ${scrolled || menu ? 'scrolled' : ''}`}>
        <a href="#home" className="lp-brand">
          <Logo size={34} />
          <span>Chaty</span>
        </a>
        <nav className={`lp-nav ${menu ? 'open' : ''}`}>
          {nav.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={active === id ? 'on' : ''} onClick={() => setMenu(false)}>
              {label}
            </a>
          ))}
          <a href={APP_URL} className="lp-nav-app">
            Open Web App
          </a>
        </nav>
        <button className="lp-menu" onClick={() => setMenu((v) => !v)} aria-label="Menu">
          {menu ? <X size={24} /> : <Menu size={24} />}
        </button>
      </header>

      <section id="home" className="lp-hero">
        <Scenery variant="wide" className="lp-bg lp-bg-wide" />
        <Scenery variant="full" className="lp-bg lp-bg-tall" />
        <div className="lp-hero-inner">
          <div className="lp-hero-text">
            <Logo size={96} />
            <h1>Chaty</h1>
            <p className="lp-tagline">Messages, voice and video calls under a calm night sky.</p>
            <div className="lp-cta">
              <a className="lp-btn-primary" href={APP_URL}>
                <Globe size={22} />
                Open Web App
              </a>
              {android ? (
                <a className="lp-btn-outline" href={android.url} download="chaty.apk">
                  <AndroidIcon />
                  Download for Android
                </a>
              ) : (
                <span className="lp-btn-outline disabled">
                  <AndroidIcon />
                  {android === undefined ? 'Download for Android' : 'Android app coming soon'}
                </span>
              )}
            </div>
            <div className="lp-cta-note">
              {install ? (
                <button className="lp-link" onClick={installApp}>
                  <Download size={15} /> Install Chaty on this device
                </button>
              ) : isIOS ? (
                <span>On iPhone: open the web app, tap Share, then “Add to Home Screen”.</span>
              ) : (
                <span>No install needed: it runs in your browser and can be added to your home screen.</span>
              )}
              {androidMeta && <span className="lp-dim">Android {androidMeta}</span>}
            </div>
            <ul className="lp-points">
              <li>
                <Lock size={26} />
                <div>
                  <b>Secure & Private</b>
                  <span>Your conversations, your control.</span>
                </div>
              </li>
              <li>
                <Zap size={26} />
                <div>
                  <b>Fast & Reliable</b>
                  <span>Always connected, anytime.</span>
                </div>
              </li>
              <li>
                <Heart size={26} />
                <div>
                  <b>Simple & Beautiful</b>
                  <span>A calm experience, inside and out.</span>
                </div>
              </li>
            </ul>
          </div>
          <PhoneMockup />
        </div>
      </section>

      <section id="features" className="lp-section">
        <h2>Everything you need to stay close</h2>
        <p className="lp-lead">A messenger that feels calm, works everywhere and keeps your calls connected.</p>
        <div className="lp-grid">
          {FEATURES.map(({ Icon, title, text }) => (
            <article key={title} className="lp-card-feature">
              <span className="lp-icon">
                <Icon size={24} />
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="about" className="lp-section lp-about">
        <h2>About Chaty</h2>
        <p>
          Chaty is a private messenger for families, friends and small teams. It runs on your own server, works in
          any modern browser and on Android, and is built to keep working on unreliable networks: messages sync
          the moment you reconnect, and calls survive short drops.
        </p>
        <p>
          New accounts are approved by your admin, so only the people you invite can join, and nobody can browse
          the member list.
        </p>
      </section>

      <section id="download" className="lp-section">
        <h2>Get Chaty</h2>
        <div className="lp-downloads">
          <article className="lp-card-download">
            <span className="lp-icon">
              <Globe size={26} />
            </span>
            <h3>Web app</h3>
            <p>Works in Chrome, Edge, Safari and Firefox on phones and computers. Nothing to install.</p>
            <ul>
              <li>Android & computers: open it, then choose “Install app” from the browser menu.</li>
              <li>iPhone: open it in Safari, tap Share, then “Add to Home Screen”.</li>
            </ul>
            <a className="lp-btn-primary small" href={APP_URL}>
              Open Web App <ArrowRight size={18} />
            </a>
          </article>
          <article className="lp-card-download">
            <span className="lp-icon">
              <AndroidIcon size={26} />
            </span>
            <h3>Android app</h3>
            <p>
              {android
                ? `Version ${android.version || '—'} · ${formatBytes(android.size)}.`
                : 'The Android app will be available here soon.'}{' '}
              After downloading, open the file. If Android asks, allow installing apps from this source. Coming
              from version 1.2 or older? Uninstall the old Chaty first (only this once), then install.
            </p>
            {android ? (
              <a className="lp-btn-outline small" href={android.url} download="chaty.apk">
                <Download size={18} /> Download APK
              </a>
            ) : (
              <span className="lp-btn-outline small disabled">Coming soon</span>
            )}
          </article>
        </div>
      </section>

      <footer className="lp-footer">
        <span>
          <Logo size={20} /> Chaty
        </span>
        <span className="lp-dim">© {new Date().getFullYear()} · Messages, voice and video calls.</span>
      </footer>
    </div>
  );
}
