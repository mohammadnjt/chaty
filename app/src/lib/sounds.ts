// Call tones synthesized with WebAudio, so there are no audio assets to ship.
import { vibrate } from './native';

let ctx: AudioContext | null = null;
let loop: number | undefined;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function note(freqs: number[], start: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + start;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.02);
  g.gain.setValueAtTime(gain, t + Math.max(0.03, dur - 0.06));
  g.gain.linearRampToValueAtTime(0, t + dur);
  g.connect(c.destination);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}

function repeat(play: () => void, every: number) {
  stopTones();
  play();
  loop = window.setInterval(play, every);
}

/** What the caller hears while the other phone rings. */
export function playRingback() {
  repeat(() => note([440, 480], 0, 1.5, 0.045), 4000);
}

/** Incoming call ringtone: a soft rising arpeggio. */
export function playRingtone() {
  repeat(() => {
    [659.3, 784, 987.8, 1318.5].forEach((f, i) => note([f], i * 0.16, 0.22, 0.07, 'triangle'));
    [659.3, 784, 987.8, 1318.5].forEach((f, i) => note([f], 0.9 + i * 0.16, 0.22, 0.07, 'triangle'));
    vibrate([400, 250, 400]);
  }, 2600);
}

export function playHangup() {
  stopTones();
  note([620], 0, 0.16, 0.05);
  note([460], 0.18, 0.22, 0.05);
}

export function playMessage() {
  note([880], 0, 0.08, 0.035);
  note([1320], 0.07, 0.1, 0.03);
}

export function stopTones() {
  clearInterval(loop);
  loop = undefined;
  vibrate(0);
}

/** Browsers only start audio after a user gesture; warm the context on the first tap. */
export function unlockAudio() {
  const once = () => {
    audio();
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
  };
  window.addEventListener('pointerdown', once);
  window.addEventListener('keydown', once);
}
