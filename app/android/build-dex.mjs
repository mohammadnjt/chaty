// Rebuilds android/classes.dex from android/src. Only needed after changing
// the Java code; `npm run apk` uses the committed classes.dex.
// Downloads the Android API jar and the dx compiler from Maven Central into
// android/.tools the first time (about 140 MB). Needs a JDK.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const tools = join(here, '.tools');
const MAVEN = 'https://repo1.maven.org/maven2';
const jars = {
  'android-all.jar': `${MAVEN}/org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar`,
  'dx.jar': `${MAVEN}/com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar`,
};

mkdirSync(tools, { recursive: true });
for (const [name, url] of Object.entries(jars)) {
  const file = join(tools, name);
  if (existsSync(file) && statSync(file).size > 100_000) continue;
  console.log(`downloading ${name}…`);
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, url], { stdio: 'inherit' });
}

const sources = [];
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.java') && sources.push(join(dir, e.name)),
  );
walk(join(here, 'src'));

const classes = join(tools, 'classes');
rmSync(classes, { recursive: true, force: true });
execFileSync('javac', ['--release', '8', '-Xlint:-options', '-cp', join(tools, 'android-all.jar'), '-d', classes, ...sources], {
  stdio: 'inherit',
});
execFileSync(
  'java',
  ['-cp', join(tools, 'dx.jar'), 'com.android.dx.command.Main', '--dex', '--min-sdk-version=21', `--output=${join(here, 'classes.dex')}`, classes],
  { stdio: 'inherit' },
);
console.log('✓ android/classes.dex rebuilt');
