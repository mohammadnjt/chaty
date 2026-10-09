// Swaps Nitron's stock WebView activity for Chaty's (android/classes.dex, built
// from android/src by build-dex.mjs) and signs the APK with Chaty's release key
// (android/release.keystore + keystore.properties, kept out of git). Without
// them it falls back to Nitron's public debug key, which anyone can sign with.
// Runs after `nitron build` as part of `npm run apk`. Needs Java and `zip`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const apk = join(here, '..', 'dist', 'app.apk');
const signer = join(here, '..', 'node_modules', 'nitron', 'vendor', 'uber-apk-signer.jar');
const keyProps = join(here, 'keystore.properties');

function releaseKey() {
  if (!existsSync(keyProps)) return null;
  const props = Object.fromEntries(
    readFileSync(keyProps, 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
  return ['--ks', join(here, props.storeFile), '--ksAlias', props.keyAlias, '--ksPass', props.storePassword, '--ksKeyPass', props.keyPassword];
}

const work = mkdtempSync(join(tmpdir(), 'chaty-apk-'));
try {
  const unsigned = join(work, 'app.apk');
  copyFileSync(apk, unsigned);
  copyFileSync(join(here, 'classes.dex'), join(work, 'classes.dex'));
  execFileSync('zip', ['-q', '-d', unsigned, 'META-INF/*'], { cwd: work });
  execFileSync('zip', ['-q', unsigned, 'classes.dex'], { cwd: work });
  const out = join(work, 'signed');
  const key = releaseKey();
  if (!key) console.warn('⚠ No android/keystore.properties: signing with the public debug key.');
  execFileSync('java', ['-jar', signer, '--apks', unsigned, '--out', out, '--allowResign', ...(key ?? [])], { stdio: 'ignore' });
  const signed = readdirSync(out).find((f) => f.endsWith('.apk'));
  if (!signed) throw new Error('signing produced no APK');
  copyFileSync(join(out, signed), apk);
  console.log(`✓ Chaty shell patched into dist/app.apk (${key ? 'release key' : 'debug key'})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
