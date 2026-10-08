import { useId } from 'react';

/** Lotus mark from the header. */
export default function Logo({ size = 32 }: { size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e9dcff" />
          <stop offset="1" stopColor="#a47bff" />
        </linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c7a9ff" />
          <stop offset="1" stopColor="#7d4ff0" />
        </linearGradient>
      </defs>
      <path d="M32 50 C14 50 4 40 3 30 C14 30 24 36 32 50 Z" fill={`url(#${id}-b)`} opacity="0.85" />
      <path d="M32 50 C50 50 60 40 61 30 C50 30 40 36 32 50 Z" fill={`url(#${id}-b)`} opacity="0.85" />
      <path d="M32 50 C18 44 12 30 15 17 C25 22 31 34 32 50 Z" fill={`url(#${id}-a)`} opacity="0.9" />
      <path d="M32 50 C46 44 52 30 49 17 C39 22 33 34 32 50 Z" fill={`url(#${id}-a)`} opacity="0.9" />
      <path d="M32 50 C24 40 23 22 32 8 C41 22 40 40 32 50 Z" fill={`url(#${id}-a)`} />
      <path d="M14 53 Q32 57 50 53" stroke="#b18cff" strokeWidth="2" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}
