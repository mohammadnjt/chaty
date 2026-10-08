// Hand-built SVG night landscape (sky, moon, mountains, lake at sunset)
// used behind headers, chats, the call screen, the sign-in page and the
// landing page ("wide", a 16:9 version).
import { memo, useId } from 'react';

type Variant = 'full' | 'header' | 'footer' | 'wide';

// Paths are drawn relative to the horizon (y = 0, negative is up), 400 wide.
const FAR =
  'M0 0 L0 -46 Q18 -58 34 -54 L58 -78 Q66 -84 74 -76 L96 -60 Q112 -66 124 -74 L150 -104 Q158 -110 166 -102 L190 -76 Q204 -70 214 -78 L238 -96 Q246 -100 254 -94 L282 -64 Q300 -56 316 -68 L342 -98 Q350 -104 358 -96 L380 -72 Q390 -66 400 -70 L400 0 Z';
const MID =
  'M0 0 L0 -26 Q30 -40 58 -34 Q84 -28 104 -44 Q120 -56 140 -42 Q160 -28 186 -32 Q214 -36 236 -24 Q258 -14 286 -22 Q312 -30 338 -20 Q366 -10 400 -18 L400 0 Z';
const SHORE_R = 'M228 1 Q262 -13 292 -10 Q330 -8 360 -15 Q384 -19 400 -16 L400 1 Z';
const SHORE_L = 'M0 1 L0 -12 Q30 -19 62 -12 Q92 -5 126 1 Z';
// Foreground bushes, relative to the bottom edge.
const BUSH_L =
  'M0 0 L0 -128 Q12 -146 28 -134 Q36 -158 56 -144 Q70 -160 84 -140 Q102 -148 106 -124 Q124 -124 120 -98 Q138 -86 122 -60 Q144 -40 130 0 Z';
const BUSH_R =
  'M400 0 L400 -150 Q388 -166 372 -152 Q360 -172 342 -156 Q326 -168 316 -146 Q296 -150 294 -126 Q274 -122 282 -98 Q262 -84 278 -60 Q258 -38 272 0 Z';

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function makeStars(count: number, w: number, h: number, seed: number) {
  const r = rng(seed);
  return Array.from({ length: count }, () => ({
    x: r() * w,
    y: r() * h,
    size: 0.35 + r() * 1.05,
    o: 0.3 + r() * 0.65,
    twinkle: r() < 0.3,
    delay: r() * 4,
  }));
}

const STARS_FULL = makeStars(70, 400, 300, 7);
const STARS_HEADER = makeStars(34, 400, 110, 11);
const STARS_WIDE = makeStars(170, 1600, 560, 23);
const WIDE_LIGHTS = Array.from({ length: 30 }, (_, i) => ({ x: 1236 + i * 12 + ((i * 37) % 9), y: -5 - ((i * 13) % 6) }));
const LIGHTS = Array.from({ length: 16 }, (_, i) => ({ x: 252 + i * 9 + ((i * 37) % 7), y: -4 - ((i * 13) % 5) }));
const FLOWERS_L = [
  [22, -120], [44, -140], [70, -136], [96, -118], [112, -92], [118, -64], [12, -96], [60, -104], [88, -84],
];
const FLOWERS_R = [
  [378, -144], [352, -150], [326, -138], [302, -118], [288, -92], [282, -66], [390, -112], [340, -110], [312, -86],
];

function Stars({ stars }: { stars: typeof STARS_FULL }) {
  return (
    <g fill="#fff">
      {stars.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={s.y}
          r={s.size}
          opacity={s.o}
          className={s.twinkle ? 'twinkle' : undefined}
          style={s.twinkle ? { animationDelay: `${s.delay}s` } : undefined}
        />
      ))}
    </g>
  );
}

function Moon({ x, y, r, id }: { x: number; y: number; r: number; id: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r * 4} fill={`url(#${id}-moonglow)`} />
      <mask id={`${id}-moonmask`}>
        <circle cx={x} cy={y} r={r} fill="#fff" />
        <circle cx={x + r * 0.45} cy={y - r * 0.3} r={r * 0.92} fill="#000" />
      </mask>
      <circle cx={x} cy={y} r={r} fill="#ffe7c4" mask={`url(#${id}-moonmask)`} />
    </g>
  );
}

function Flowers({ points, y }: { points: number[][]; y: number }) {
  return (
    <g>
      {points.map(([x, dy], i) => (
        <g key={i} transform={`translate(${x} ${y + dy})`}>
          <circle r={i % 3 === 0 ? 4.2 : 3.2} fill={i % 2 ? '#f49cc0' : '#f7b0cf'} opacity={0.9} />
          <circle r={1.3} fill="#ffe1ec" />
        </g>
      ))}
    </g>
  );
}

function Defs({ id, variant }: { id: string; variant: Variant }) {
  return (
    <defs>
      <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
        {variant === 'header' ? (
          <>
            <stop offset="0" stopColor="#0a0d29" />
            <stop offset="0.5" stopColor="#161b4f" />
            <stop offset="0.8" stopColor="#33307a" />
            <stop offset="0.93" stopColor="#7a4f97" />
            <stop offset="1" stopColor="#d9808a" />
          </>
        ) : variant === 'footer' ? (
          <>
            <stop offset="0" stopColor="#2a2a6e" stopOpacity="0" />
            <stop offset="0.45" stopColor="#3b3480" stopOpacity="0.55" />
            <stop offset="0.8" stopColor="#8e5397" />
            <stop offset="1" stopColor="#f0957f" />
          </>
        ) : (
          <>
            <stop offset="0" stopColor="#080b24" />
            <stop offset="0.3" stopColor="#131a4b" />
            <stop offset="0.55" stopColor="#2c2d76" />
            <stop offset="0.74" stopColor="#5a4597" />
            <stop offset="0.87" stopColor="#a55b9b" />
            <stop offset="0.95" stopColor="#ea8b86" />
            <stop offset="1" stopColor="#ffb689" />
          </>
        )}
      </linearGradient>
      <radialGradient id={`${id}-sun`}>
        <stop offset="0" stopColor="#ffe2b3" stopOpacity="0.95" />
        <stop offset="0.18" stopColor="#ffbf91" stopOpacity="0.7" />
        <stop offset="0.5" stopColor="#f38f8c" stopOpacity="0.28" />
        <stop offset="1" stopColor="#c46aa0" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${id}-moonglow`}>
        <stop offset="0" stopColor="#ffe9cf" stopOpacity="0.35" />
        <stop offset="1" stopColor="#ffe9cf" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#7c66bb" />
        <stop offset="1" stopColor="#463b88" />
      </linearGradient>
      <linearGradient id={`${id}-water`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6f529e" />
        <stop offset="0.22" stopColor="#3d3679" />
        <stop offset="0.6" stopColor="#1b1d4f" />
        <stop offset="1" stopColor="#0a0c27" />
      </linearGradient>
      <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#7c66bb" stopOpacity="0.3" />
        <stop offset="1" stopColor="#7c66bb" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

function Clouds({ h }: { h: number }) {
  return (
    <g>
      <g transform={`translate(86 ${h - 128})`} fill="#c98bd0" opacity={0.28}>
        <ellipse rx={64} ry={8} />
        <ellipse cx={28} cy={-6} rx={38} ry={9} />
        <ellipse cx={-26} cy={-2} rx={28} ry={6} />
      </g>
      <g transform={`translate(306 ${h - 182})`} fill="#9a7fe0" opacity={0.25}>
        <ellipse rx={74} ry={7} />
        <ellipse cx={-22} cy={-5} rx={36} ry={8} />
      </g>
      <g transform={`translate(214 ${h - 74})`} fill="#ffb4a2" opacity={0.32}>
        <ellipse rx={96} ry={6} />
        <ellipse cx={40} cy={-4} rx={44} ry={6} />
      </g>
      <g transform={`translate(44 ${h - 52})`} fill="#f39cb6" opacity={0.3}>
        <ellipse rx={64} ry={5} />
      </g>
      <g transform={`translate(360 ${h - 102})`} fill="#f2a3c4" opacity={0.22}>
        <ellipse rx={58} ry={6} />
      </g>
    </g>
  );
}

function Lake({ id, h, bottom, sunX }: { id: string; h: number; bottom: number; sunX: number }) {
  return (
    <g>
      <rect x={0} y={h} width={400} height={bottom - h} fill={`url(#${id}-water)`} />
      <path d={FAR} transform={`translate(0 ${h}) scale(1 -0.7)`} fill={`url(#${id}-fade)`} />
      <path d={MID} transform={`translate(0 ${h}) scale(1 -0.8)`} fill="#2a2766" opacity={0.35} />
      {Array.from({ length: 13 }, (_, i) => {
        const w = 58 - i * 3.4 + (i % 2) * 9;
        return (
          <rect
            key={i}
            x={sunX - w / 2 + ((i * 7) % 5) - 2}
            y={h + 5 + i * 8.5}
            width={w}
            height={2}
            rx={1}
            fill="#ffd2a8"
            opacity={0.6 - i * 0.04}
          />
        );
      })}
      {[
        [40, 26, 70],
        [130, 48, 54],
        [300, 64, 80],
        [70, 92, 64],
        [220, 120, 90],
      ].map(([x, dy, w], i) => (
        <rect key={i} x={x} y={h + dy} width={w} height={1.2} rx={0.6} fill="#c7b6ff" opacity={0.12} />
      ))}
    </g>
  );
}

function Mountains({ id, h, scale = 1 }: { id: string; h: number; scale?: number }) {
  return (
    <g>
      <path d={FAR} transform={`translate(0 ${h}) scale(1 ${scale})`} fill={`url(#${id}-far)`} />
      <path d={MID} transform={`translate(0 ${h}) scale(1 ${scale})`} fill="#2b2862" />
      <path d={SHORE_L} transform={`translate(0 ${h})`} fill="#17163f" />
      <path d={SHORE_R} transform={`translate(0 ${h})`} fill="#141339" />
      <g transform={`translate(0 ${h})`}>
        {LIGHTS.map((l, i) => (
          <g key={i}>
            <circle cx={l.x} cy={l.y} r={2.4} fill="#ffcf8a" opacity={0.18} />
            <circle cx={l.x} cy={l.y} r={0.8} fill="#ffe1a8" />
            <rect x={l.x - 0.4} y={3} width={0.8} height={5 + (i % 4) * 2} fill="#ffcf8a" opacity={0.35} />
          </g>
        ))}
      </g>
    </g>
  );
}

// 1600×900: the 400-wide ridges are tiled, every other tile mirrored so the
// skyline stays continuous.
function WideScene({ id, className }: { id: string; className?: string }) {
  const W = 1600;
  const H = 640;
  const B = 900;
  const sunX = 1150;
  const tile = (d: string, fill: string, sy: number, opacity = 1) =>
    [0, 1, 2, 3].map((i) => (
      <path
        key={i}
        d={d}
        fill={fill}
        opacity={opacity}
        transform={`translate(${i % 2 ? (i + 1) * 400 : i * 400} ${H}) scale(${i % 2 ? -1 : 1} ${sy})`}
      />
    ));
  return (
    <svg className={className} viewBox={`0 0 ${W} ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <Defs id={id} variant="full" />
      <rect width={W} height={H + 1} fill={`url(#${id}-sky)`} />
      <Stars stars={STARS_WIDE} />
      <Moon id={id} x={1470} y={105} r={26} />
      <g transform="scale(4 1)">
        <Clouds h={H} />
      </g>
      <circle cx={sunX} cy={H - 20} r={420} fill={`url(#${id}-sun)`} />
      <circle cx={sunX} cy={H - 26} r={22} fill="#fff1d6" />
      {tile(FAR, `url(#${id}-far)`, 1.45)}
      {tile(MID, '#2b2862', 1.7)}
      <path d={SHORE_L} transform={`translate(0 ${H}) scale(2.4 1.3)`} fill="#17163f" />
      <path d={SHORE_R} transform={`translate(${W - 400 * 1.2} ${H}) scale(1.2 1.3)`} fill="#141339" />
      <g transform={`translate(0 ${H})`}>
        {WIDE_LIGHTS.map((l, i) => (
          <g key={i}>
            <circle cx={l.x} cy={l.y} r={3.2} fill="#ffcf8a" opacity={0.2} />
            <circle cx={l.x} cy={l.y} r={1.1} fill="#ffe1a8" />
            <rect x={l.x - 0.5} y={4} width={1} height={8 + (i % 4) * 3} fill="#ffcf8a" opacity={0.3} />
          </g>
        ))}
      </g>
      <rect x={0} y={H} width={W} height={B - H} fill={`url(#${id}-water)`} />
      {tile(FAR, `url(#${id}-fade)`, -1)}
      {tile(MID, '#2a2766', -1.1, 0.35)}
      {Array.from({ length: 16 }, (_, i) => {
        const w = 150 - i * 8 + (i % 2) * 18;
        return (
          <rect key={i} x={sunX - w / 2 + ((i * 7) % 9) - 4} y={H + 6 + i * 13} width={w} height={3} rx={1.5} fill="#ffd2a8" opacity={0.6 - i * 0.033} />
        );
      })}
      {[
        [120, 40, 260],
        [520, 80, 200],
        [820, 130, 300],
        [300, 170, 240],
        [1320, 110, 220],
      ].map(([x, dy, w], i) => (
        <rect key={i} x={x} y={H + dy} width={w} height={1.6} rx={0.8} fill="#c7b6ff" opacity={0.12} />
      ))}
      <g transform={`translate(0 ${B}) scale(1.55)`} fill="#090a20">
        <path d={BUSH_L} />
      </g>
      <g transform={`translate(${W} ${B}) scale(1.55) translate(-400 0)`} fill="#090a20">
        <path d={BUSH_R} />
      </g>
      <g transform={`translate(0 ${B}) scale(1.55)`}>
        <Flowers points={FLOWERS_L} y={0} />
      </g>
      <g transform={`translate(${W} ${B}) scale(1.55) translate(-400 0)`}>
        <Flowers points={FLOWERS_R} y={0} />
      </g>
    </svg>
  );
}

function Scenery({ variant = 'full', className }: { variant?: Variant; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');

  if (variant === 'wide') return <WideScene id={id} className={className} />;

  if (variant === 'header') {
    const H = 150;
    return (
      <svg className={className} viewBox="0 0 400 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <Defs id={id} variant="header" />
        <rect width={400} height={H} fill={`url(#${id}-sky)`} />
        <Stars stars={STARS_HEADER} />
        <Moon id={id} x={262} y={44} r={11} />
        <circle cx={288} cy={H - 12} r={90} fill={`url(#${id}-sun)`} />
        <circle cx={288} cy={H - 14} r={7} fill="#fff0d2" />
        <path d={FAR} transform={`translate(0 ${H}) scale(1 0.52)`} fill={`url(#${id}-far)`} opacity={0.9} />
        <path d={MID} transform={`translate(0 ${H}) scale(1 0.62)`} fill="#232057" />
      </svg>
    );
  }

  if (variant === 'footer') {
    const H = 112;
    const B = 240;
    return (
      <svg className={className} viewBox={`0 0 400 ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <Defs id={id} variant="footer" />
        <rect width={400} height={H + 1} fill={`url(#${id}-sky)`} />
        <circle cx={288} cy={H - 14} r={110} fill={`url(#${id}-sun)`} />
        <circle cx={288} cy={H - 16} r={10} fill="#fff1d6" />
        <Mountains id={id} h={H} scale={0.75} />
        <Lake id={id} h={H} bottom={B} sunX={288} />
        <g transform={`translate(0 ${B}) scale(0.8)`} fill="#090a20">
          <path d={BUSH_L} />
        </g>
        <g transform={`translate(80 ${B}) scale(0.8)`} fill="#090a20">
          <path d={BUSH_R} />
        </g>
        <g transform={`translate(0 ${B}) scale(0.8)`}>
          <Flowers points={FLOWERS_L} y={0} />
        </g>
        <g transform={`translate(80 ${B}) scale(0.8)`}>
          <Flowers points={FLOWERS_R} y={0} />
        </g>
      </svg>
    );
  }

  const H = 520;
  const B = 760;
  return (
    <svg className={className} viewBox={`0 0 400 ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <Defs id={id} variant="full" />
      <rect width={400} height={H + 1} fill={`url(#${id}-sky)`} />
      <Stars stars={STARS_FULL} />
      <Moon id={id} x={316} y={92} r={15} />
      <Clouds h={H} />
      <circle cx={288} cy={H - 20} r={150} fill={`url(#${id}-sun)`} />
      <circle cx={288} cy={H - 24} r={15} fill="#fff1d6" />
      <Mountains id={id} h={H} />
      <Lake id={id} h={H} bottom={B} sunX={288} />
      <g transform={`translate(0 ${B})`} fill="#090a20">
        <path d={BUSH_L} />
        <path d={BUSH_R} />
      </g>
      <Flowers points={FLOWERS_L} y={B} />
      <Flowers points={FLOWERS_R} y={B} />
    </svg>
  );
}

export default memo(Scenery);
