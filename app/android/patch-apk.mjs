// Swaps Nitron's stock WebView activity for Chaty's (android/classes.dex, built
// from android/src by build-dex.mjs) and signs the APK again with the same key
// Nitron uses, so installed copies update in place.
// Runs after `nitron build` as part of `npm run apk`. Needs Java and `zip`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const apk = join(here, '..', 'dist', 'app.apk');
const signer = join(here, '..', 'node_modules', 'nitron', 'vendor', 'uber-apk-signer.jar');

const work = mkdtempSync(join(tmpdir(), 'chaty-apk-'));
try {
  const unsigned = join(work, 'app.apk');
  copyFileSync(apk, unsigned);
  copyFileSync(join(here, 'classes.dex'), join(work, 'classes.dex'));
  execFileSync('zip', ['-q', '-d', unsigned, 'META-INF/*'], { cwd: work });
  execFileSync('zip', ['-q', unsigned, 'classes.dex'], { cwd: work });
  const out = join(work, 'signed');
  execFileSync('java', ['-jar', signer, '--apks', unsigned, '--out', out, '--allowResign'], { stdio: 'ignore' });
  const signed = readdirSync(out).find((f) => f.endsWith('.apk'));
  if (!signed) throw new Error('signing produced no APK');
  copyFileSync(join(out, signed), apk);
  console.log('✓ Chaty shell patched into dist/app.apk');
} finally {
  rmSync(work, { recursive: true, force: true });
}
