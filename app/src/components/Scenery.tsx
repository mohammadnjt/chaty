// Hand-built SVG landscape used behind headers, chats, the call screen, the
// sign-in page and the landing page ("wide", a 16:9 version): a night sky
// with the moon and a sunset over the lake, or, in the light theme, a sunny
// day with clouds, green hills and flowers.
import { memo, useId } from 'react';
import { useTheme } from '../lib/theme';

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
// Daytime meadow along the bottom edge, 400 wide.
const MEADOW = 'M0 0 L0 -38 Q60 -58 130 -46 Q200 -34 262 -48 Q330 -62 400 -44 L400 0 Z';

type Stop = [offset: number, color: string, opacity?: number];

const NIGHT = {
  day: false,
  sky: [[0, '#080b24'], [0.3, '#131a4b'], [0.55, '#2c2d76'], [0.74, '#5a4597'], [0.87, '#a55b9b'], [0.95, '#ea8b86'], [1, '#ffb689']] as Stop[],
  skyHeader: [[0, '#0a0d29'], [0.5, '#161b4f'], [0.8, '#33307a'], [0.93, '#7a4f97'], [1, '#d9808a']] as Stop[],
  skyFooter: [[0, '#2a2a6e', 0], [0.45, '#3b3480', 0.55], [0.8, '#8e5397'], [1, '#f0957f']] as Stop[],
  glow: [[0, '#ffe2b3', 0.95], [0.18, '#ffbf91', 0.7], [0.5, '#f38f8c', 0.28], [1, '#c46aa0', 0]] as Stop[],
  far: [[0, '#7c66bb'], [1, '#463b88']] as Stop[],
  water: [[0, '#6f529e'], [0.22, '#3d3679'], [0.6, '#1b1d4f'], [1, '#0a0c27']] as Stop[],
  fade: '#7c66bb',
  mid: '#2b2862',
  midHeader: '#232057',
  midReflection: '#2a2766',
  shoreL: '#17163f',
  shoreR: '#141339',
  glint: '#ffd2a8',
  ripple: '#c7b6ff',
  rippleOpacity: 0.12,
  bush: '#090a20',
  flowers: ['#f49cc0', '#f7b0cf'],
  flowerCenter: '#ffe1ec',
};

const DAY: typeof NIGHT = {
  day: true,
  sky: [[0, '#1f6fd6'], [0.32, '#3d92e9'], [0.6, '#72b8f3'], [0.84, '#b4dcf8'], [1, '#e2f2fc']],
  skyHeader: [[0, '#2577de'], [0.55, '#4f9fed'], [1, '#a9d5f6']],
  skyFooter: [[0, '#8cc8f3', 0], [0.45, '#a4d4f6', 0.55], [1, '#d4ecfb']],
  glow: [[0, '#ffffff', 0.55], [0.4, '#eaf6ff', 0.25], [1, '#ffffff', 0]],
  far: [[0, '#8dbde8'], [1, '#5b98d2']],
  water: [[0, '#9fdcf4'], [0.22, '#5cbde9'], [0.6, '#349ad6'], [1, '#1c72b8']],
  fade: '#8dbde8',
  mid: '#4ea56e',
  midHeader: '#3f9a63',
  midReflection: '#2f8a5c',
  shoreL: '#2f8b4f',
  shoreR: '#2a8048',
  glint: '#ffffff',
  ripple: '#ffffff',
  rippleOpacity: 0.3,
  bush: '#2a8547',
  flowers: ['#ffffff', '#fff4f8'],
  flowerCenter: '#ffd54a',
};

type Palette = typeof NIGHT;

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

function Sun({ x, y, r, id }: { x: number; y: number; r: number; id: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r * 4.2} fill={`url(#${id}-sunglow)`} />
      <g stroke="#ffe680" strokeWidth={r * 0.13} strokeLinecap="round" opacity={0.85}>
        {Array.from({ length: 12 }, (_, i) => {
          const angle = (i / 12) * Math.PI * 2;
          const [inner, outer] = [r * 1.35, r * (i % 2 ? 1.85 : 2.15)];
          return (
            <line
              key={i}
              x1={x + Math.cos(angle) * inner}
              y1={y + Math.sin(angle) * inner}
              x2={x + Math.cos(angle) * outer}
              y2={y + Math.sin(angle) * outer}
            />
          );
        })}
      </g>
      <circle cx={x} cy={y} r={r} fill="#ffe25c" />
      <circle cx={x - r * 0.18} cy={y - r * 0.18} r={r * 0.62} fill="#fff3a6" opacity={0.7} />
    </g>
  );
}

/** The moon at night, the sun by day; clickable where the scene offers a theme switch. */
function SkyLight({ p, onClick, ...at }: { p: Palette; x: number; y: number; r: number; id: string; onClick?: () => void }) {
  const body = p.day ? <Sun {...at} /> : <Moon {...at} />;
  if (!onClick) return body;
  return (
    <g
      className="sky-switch"
      role="button"
      tabIndex={0}
      aria-label={p.day ? 'Switch to night' : 'Switch to day'}
      onClick={onClick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClick()}
    >
      <circle cx={at.x} cy={at.y} r={at.r * 2.6} fill="transparent" />
      {body}
    </g>
  );
}

function Flowers({ points, y, p }: { points: number[][]; y: number; p: Palette }) {
  return (
    <g>
      {points.map(([x, dy], i) => (
        <g key={i} transform={`translate(${x} ${y + dy})`}>
          <circle r={i % 3 === 0 ? 4.2 : 3.2} fill={p.flowers[i % 2]} opacity={0.9} />
          <circle r={1.3} fill={p.flowerCenter} />
        </g>
      ))}
    </g>
  );
}

const stops = (list: Stop[]) =>
  list.map(([offset, color, opacity], i) => <stop key={i} offset={offset} stopColor={color} stopOpacity={opacity ?? 1} />);

function Defs({ id, variant, p }: { id: string; variant: Variant; p: Palette }) {
  return (
    <defs>
      <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
        {stops(variant === 'header' ? p.skyHeader : variant === 'footer' ? p.skyFooter : p.sky)}
      </linearGradient>
      <radialGradient id={`${id}-sun`}>{stops(p.glow)}</radialGradient>
      <radialGradient id={`${id}-moonglow`}>
        <stop offset="0" stopColor="#ffe9cf" stopOpacity="0.35" />
        <stop offset="1" stopColor="#ffe9cf" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${id}-sunglow`}>
        <stop offset="0" stopColor="#fff7c2" stopOpacity="0.9" />
        <stop offset="0.35" stopColor="#ffef9a" stopOpacity="0.35" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>
      <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
        {stops(p.far)}
      </linearGradient>
      <linearGradient id={`${id}-water`} x1="0" y1="0" x2="0" y2="1">
        {stops(p.water)}
      </linearGradient>
      <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={p.fade} stopOpacity="0.3" />
        <stop offset="1" stopColor={p.fade} stopOpacity="0" />
      </linearGradient>
      <linearGradient id={`${id}-meadow`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#6cc35f" />
        <stop offset="1" stopColor="#2f8a3e" />
      </linearGradient>
    </defs>
  );
}

function NightClouds({ h }: { h: number }) {
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

/** A fluffy cumulus, centred at (x, y). */
function Cloud({ x, y, s = 1, o = 0.95 }: { x: number; y: number; s?: number; o?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} opacity={o}>
      <ellipse cx={0} cy={6} rx={46} ry={11} fill="#d7ebfa" />
      <g fill="#ffffff">
        <ellipse cx={0} cy={2} rx={44} ry={11} />
        <circle cx={-20} cy={-4} r={14} />
        <circle cx={2} cy={-12} r={18} />
        <circle cx={24} cy={-4} r={12} />
      </g>
    </g>
  );
}

// Kept to the sides: the middle of the sky is where screens put text.
function DayClouds({ h }: { h: number }) {
  return (
    <g>
      <Cloud x={62} y={h - 310} s={0.9} />
      <Cloud x={352} y={h - 250} s={0.55} o={0.85} />
      <Cloud x={34} y={h - 150} s={0.7} o={0.9} />
      <Cloud x={362} y={h - 105} s={0.6} o={0.85} />
    </g>
  );
}

function Clouds({ h, p }: { h: number; p: Palette }) {
  return p.day ? <DayClouds h={h} /> : <NightClouds h={h} />;
}

/** Lit windows along the far shore at night; a little village by day. */
function ShoreLights({ points, scale = 1, p }: { points: { x: number; y: number }[]; scale?: number; p: Palette }) {
  if (p.day) {
    return (
      <g>
        {points.map((l, i) => (
          <g key={i} transform={`translate(${l.x} ${l.y - 1})`}>
            <rect x={-1.6 * scale} y={-1.4 * scale} width={3.2 * scale} height={2.6 * scale} fill="#fdfaf2" />
            <path d={`M${-2 * scale} ${-1.4 * scale} L0 ${-3.2 * scale} L${2 * scale} ${-1.4 * scale} Z`} fill={i % 3 ? '#e2674f' : '#c9553f'} />
          </g>
        ))}
      </g>
    );
  }
  return (
    <g>
      {points.map((l, i) => (
        <g key={i}>
          <circle cx={l.x} cy={l.y} r={2.4 * scale} fill="#ffcf8a" opacity={0.18} />
          <circle cx={l.x} cy={l.y} r={0.8 * scale} fill="#ffe1a8" />
          <rect x={l.x - 0.4 * scale} y={3 * scale} width={0.8 * scale} height={(5 + (i % 4) * 2) * scale} fill="#ffcf8a" opacity={0.35} />
        </g>
      ))}
    </g>
  );
}

function Lake({ id, h, bottom, sunX, p }: { id: string; h: number; bottom: number; sunX: number; p: Palette }) {
  return (
    <g>
      <rect x={0} y={h} width={400} height={bottom - h} fill={`url(#${id}-water)`} />
      <path d={FAR} transform={`translate(0 ${h}) scale(1 -0.7)`} fill={`url(#${id}-fade)`} />
      <path d={MID} transform={`translate(0 ${h}) scale(1 -0.8)`} fill={p.midReflection} opacity={0.35} />
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
            fill={p.glint}
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
        <rect key={i} x={x} y={h + dy} width={w} height={1.2} rx={0.6} fill={p.ripple} opacity={p.rippleOpacity} />
      ))}
    </g>
  );
}

function Mountains({ id, h, scale = 1, p }: { id: string; h: number; scale?: number; p: Palette }) {
  return (
    <g>
      <path d={FAR} transform={`translate(0 ${h}) scale(1 ${scale})`} fill={`url(#${id}-far)`} />
      <path d={MID} transform={`translate(0 ${h}) scale(1 ${scale})`} fill={p.mid} />
      <path d={SHORE_L} transform={`translate(0 ${h})`} fill={p.shoreL} />
      <path d={SHORE_R} transform={`translate(0 ${h})`} fill={p.shoreR} />
      <g transform={`translate(0 ${h})`}>
        <ShoreLights points={LIGHTS} p={p} />
      </g>
    </g>
  );
}

/** Grass along the bottom edge, by day. */
function Meadow({ id, bottom, width = 400, sy = 1 }: { id: string; bottom: number; width?: number; sy?: number }) {
  return <path d={MEADOW} transform={`translate(0 ${bottom}) scale(${width / 400} ${sy})`} fill={`url(#${id}-meadow)`} />;
}

// 1600×900: the 400-wide ridges are tiled, every other tile mirrored so the
// skyline stays continuous.
function WideScene({ id, className, p, onSkyClick }: { id: string; className?: string; p: Palette; onSkyClick?: () => void }) {
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
    <svg className={className} viewBox={`0 0 ${W} ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden={!onSkyClick}>
      <Defs id={id} variant="full" p={p} />
      <rect width={W} height={H + 1} fill={`url(#${id}-sky)`} />
      {!p.day && <Stars stars={STARS_WIDE} />}
      {p.day ? (
        <g>
          <Cloud x={210} y={H - 470} s={1.7} />
          <Cloud x={430} y={H - 400} s={0.9} o={0.85} />
          <Cloud x={120} y={H - 250} s={1.3} o={0.9} />
          <Cloud x={700} y={H - 330} s={0.8} o={0.8} />
          <Cloud x={980} y={H - 200} s={1.1} o={0.85} />
          <Cloud x={1290} y={H - 320} s={1.2} o={0.9} />
          <Cloud x={1520} y={H - 170} s={0.9} o={0.85} />
        </g>
      ) : (
        <g transform="scale(4 1)">
          <NightClouds h={H} />
        </g>
      )}
      <circle cx={sunX} cy={H - 20} r={420} fill={`url(#${id}-sun)`} />
      {!p.day && <circle cx={sunX} cy={H - 26} r={22} fill="#fff1d6" />}
      {tile(FAR, `url(#${id}-far)`, 1.45)}
      {tile(MID, p.mid, 1.7)}
      <path d={SHORE_L} transform={`translate(0 ${H}) scale(2.4 1.3)`} fill={p.shoreL} />
      <path d={SHORE_R} transform={`translate(${W - 400 * 1.2} ${H}) scale(1.2 1.3)`} fill={p.shoreR} />
      <g transform={`translate(0 ${H})`}>
        <ShoreLights points={WIDE_LIGHTS} scale={1.35} p={p} />
      </g>
      <rect x={0} y={H} width={W} height={B - H} fill={`url(#${id}-water)`} />
      {tile(FAR, `url(#${id}-fade)`, -1)}
      {tile(MID, p.midReflection, -1.1, 0.35)}
      {Array.from({ length: 16 }, (_, i) => {
        const w = 150 - i * 8 + (i % 2) * 18;
        return (
          <rect key={i} x={sunX - w / 2 + ((i * 7) % 9) - 4} y={H + 6 + i * 13} width={w} height={3} rx={1.5} fill={p.glint} opacity={0.6 - i * 0.033} />
        );
      })}
      {[
        [120, 40, 260],
        [520, 80, 200],
        [820, 130, 300],
        [300, 170, 240],
        [1320, 110, 220],
      ].map(([x, dy, w], i) => (
        <rect key={i} x={x} y={H + dy} width={w} height={1.6} rx={0.8} fill={p.ripple} opacity={p.rippleOpacity} />
      ))}
      {p.day && <Meadow id={id} bottom={B} width={W} sy={1.4} />}
      <g transform={`translate(0 ${B}) scale(1.55)`} fill={p.bush}>
        <path d={BUSH_L} />
      </g>
      <g transform={`translate(${W} ${B}) scale(1.55) translate(-400 0)`} fill={p.bush}>
        <path d={BUSH_R} />
      </g>
      <g transform={`translate(0 ${B}) scale(1.55)`}>
        <Flowers points={FLOWERS_L} y={0} p={p} />
      </g>
      <g transform={`translate(${W} ${B}) scale(1.55) translate(-400 0)`}>
        <Flowers points={FLOWERS_R} y={0} p={p} />
      </g>
      <SkyLight p={p} id={id} x={1470} y={105} r={p.day ? 34 : 26} onClick={onSkyClick} />
    </svg>
  );
}

/**
 * The landscape. onSkyClick makes the moon / sun a button (the landing page
 * uses it to switch between night and day).
 */
function Scenery({ variant = 'full', className, onSkyClick }: { variant?: Variant; className?: string; onSkyClick?: () => void }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const p = useTheme((s) => s.theme) === 'light' ? DAY : NIGHT;

  if (variant === 'wide') return <WideScene id={id} className={className} p={p} onSkyClick={onSkyClick} />;

  if (variant === 'header') {
    const H = 150;
    return (
      <svg className={className} viewBox="0 0 400 150" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <Defs id={id} variant="header" p={p} />
        <rect width={400} height={H} fill={`url(#${id}-sky)`} />
        {p.day ? <Cloud x={120} y={58} s={0.45} o={0.9} /> : <Stars stars={STARS_HEADER} />}
        <SkyLight p={p} id={id} x={262} y={44} r={p.day ? 13 : 11} />
        <circle cx={288} cy={H - 12} r={90} fill={`url(#${id}-sun)`} />
        {!p.day && <circle cx={288} cy={H - 14} r={7} fill="#fff0d2" />}
        <path d={FAR} transform={`translate(0 ${H}) scale(1 0.52)`} fill={`url(#${id}-far)`} opacity={0.9} />
        <path d={MID} transform={`translate(0 ${H}) scale(1 0.62)`} fill={p.midHeader} />
      </svg>
    );
  }

  if (variant === 'footer') {
    const H = 112;
    const B = 240;
    return (
      <svg className={className} viewBox={`0 0 400 ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <Defs id={id} variant="footer" p={p} />
        <rect width={400} height={H + 1} fill={`url(#${id}-sky)`} />
        <circle cx={288} cy={H - 14} r={110} fill={`url(#${id}-sun)`} />
        {!p.day && <circle cx={288} cy={H - 16} r={10} fill="#fff1d6" />}
        <Mountains id={id} h={H} scale={0.75} p={p} />
        <Lake id={id} h={H} bottom={B} sunX={288} p={p} />
        {p.day && <Meadow id={id} bottom={B} sy={0.8} />}
        <g transform={`translate(0 ${B}) scale(0.8)`} fill={p.bush}>
          <path d={BUSH_L} />
        </g>
        <g transform={`translate(80 ${B}) scale(0.8)`} fill={p.bush}>
          <path d={BUSH_R} />
        </g>
        <g transform={`translate(0 ${B}) scale(0.8)`}>
          <Flowers points={FLOWERS_L} y={0} p={p} />
        </g>
        <g transform={`translate(80 ${B}) scale(0.8)`}>
          <Flowers points={FLOWERS_R} y={0} p={p} />
        </g>
      </svg>
    );
  }

  const H = 520;
  const B = 760;
  return (
    <svg className={className} viewBox={`0 0 400 ${B}`} preserveAspectRatio="xMidYMax slice" aria-hidden={!onSkyClick}>
      <Defs id={id} variant="full" p={p} />
      <rect width={400} height={H + 1} fill={`url(#${id}-sky)`} />
      {!p.day && <Stars stars={STARS_FULL} />}
      <Clouds h={H} p={p} />
      <circle cx={288} cy={H - 20} r={150} fill={`url(#${id}-sun)`} />
      {!p.day && <circle cx={288} cy={H - 24} r={15} fill="#fff1d6" />}
      <Mountains id={id} h={H} p={p} />
      <Lake id={id} h={H} bottom={B} sunX={288} p={p} />
      {p.day && <Meadow id={id} bottom={B} />}
      <g transform={`translate(0 ${B})`} fill={p.bush}>
        <path d={BUSH_L} />
        <path d={BUSH_R} />
      </g>
      <Flowers points={FLOWERS_L} y={B} p={p} />
      <Flowers points={FLOWERS_R} y={B} p={p} />
      <SkyLight p={p} id={id} x={316} y={92} r={p.day ? 18 : 15} onClick={onSkyClick} />
    </svg>
  );
}

export default memo(Scenery);
