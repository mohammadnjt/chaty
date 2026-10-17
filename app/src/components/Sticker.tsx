import type { AnimationItem } from 'lottie-web';
import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../lib/config';

// One sticker: a picture (WebP, PNG, GIF), a video sticker (WebM) or an
// animated one (.tgs, played with lottie-web, loaded only when one shows up).

export function stickerKind(url = ''): 'image' | 'video' | 'lottie' {
  const ext = url.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  return ext === 'tgs' ? 'lottie' : ext === 'webm' ? 'video' : 'image';
}

let lottie: Promise<typeof import('lottie-web/build/player/lottie_light').default> | null = null;
const loadLottie = () => (lottie ??= import('lottie-web/build/player/lottie_light').then((m) => m.default));

// The server sends .tgs files gzipped, so they arrive as plain Lottie JSON.
const texts = new Map<string, Promise<string>>();
function lottieText(src: string) {
  let p = texts.get(src);
  if (!p) {
    p = fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
    p.catch(() => texts.delete(src));
    texts.set(src, p);
  }
  return p;
}

function useOnScreen(ref: React.RefObject<HTMLElement | null>) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setOn(true);
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

/**
 * play: 'auto' moves while on screen (in chats); 'hover' only while the
 * pointer or a finger is on it (pickers, where dozens at once would weigh on
 * a phone).
 */
export default function Sticker({ url, size, play = 'auto' }: { url: string; size?: number; play?: 'auto' | 'hover' }) {
  const box = useRef<HTMLDivElement>(null);
  const visible = useOnScreen(box);
  const [hover, setHover] = useState(false);
  const kind = stickerKind(url);
  const src = mediaUrl(url);
  const moving = visible && (play === 'auto' || hover);
  return (
    <div
      ref={box}
      className="sticker"
      style={size ? { width: size, height: size } : undefined}
      onPointerEnter={play === 'hover' ? () => setHover(true) : undefined}
      onPointerLeave={play === 'hover' ? () => setHover(false) : undefined}
    >
      {kind === 'image' ? (
        <img src={src} alt="" loading="lazy" draggable={false} />
      ) : kind === 'video' ? (
        <StickerVideo src={src} moving={moving} />
      ) : (
        <StickerLottie src={src} visible={visible} moving={moving} />
      )}
    </div>
  );
}

function StickerVideo({ src, moving }: { src: string; moving: boolean }) {
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = v.current;
    if (!el) return;
    if (moving) void el.play().catch(() => {});
    else el.pause();
  }, [moving]);
  return <video ref={v} src={src} muted loop playsInline preload="metadata" disablePictureInPicture />;
}

function StickerLottie({ src, visible, moving }: { src: string; visible: boolean; moving: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const anim = useRef<AnimationItem | null>(null);
  const [ready, setReady] = useState(false);

  // Loaded the first time it comes on screen.
  useEffect(() => {
    if (!visible || anim.current) return;
    let cancelled = false;
    Promise.all([loadLottie(), lottieText(src)])
      .then(([player, text]) => {
        if (cancelled || !el.current) return;
        anim.current = player.loadAnimation({
          container: el.current,
          renderer: 'svg',
          loop: true,
          autoplay: false,
          animationData: JSON.parse(text),
        });
        setReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, src]);

  useEffect(
    () => () => {
      anim.current?.destroy();
      anim.current = null;
    },
    [],
  );

  useEffect(() => {
    const a = anim.current;
    if (!a) return;
    if (moving) a.play();
    else a.goToAndStop(0, true);
  }, [moving, ready]);

  return <div ref={el} className="sticker-lottie" />;
}
