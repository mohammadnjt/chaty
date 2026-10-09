#!/usr/bin/env python3
"""Builds Chaty's Android app: dist/app.apk.

`nitron build` runs first and supplies the web app and the launcher icons.
This builds the native side Nitron's fixed template can't: Chaty's own
activity (android/src), Firebase push notifications, and a manifest with the
services they need. Steps:

  1. resolve the Firebase Messaging SDK and download it from Maven (cached in
     android/.tools, mirrors that work from Iran first)
  2. write the manifest and merge in the libraries' manifests
  3. compile and link resources with aapt2 (app icon, google-services.json
     values, library resources) and generate the R classes
  4. compile android/src with javac and dex everything with d8
  5. zip it with the web app and sign it with Chaty's release key

Needs a JDK, Python 3, google-services.json in the repo root, and Nitron's
aapt2 and android.jar in ~/.nitron/android (Nitron downloads them on its
first build).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

HERE = Path(__file__).resolve().parent
APP = HERE.parent
ROOT = APP.parent
TOOLS = HERE / '.tools'
NITRON = Path.home() / '.nitron' / 'android'
AAPT2, ANDROID_JAR = NITRON / 'aapt2', NITRON / 'android.jar'
SIGNER = APP / 'node_modules' / 'nitron' / 'vendor' / 'uber-apk-signer.jar'
APK = APP / 'dist' / 'app.apk'

FIREBASE = [('com.google.firebase', 'firebase-messaging', '24.1.2')]
D8 = ('com.android.tools', 'r8', '8.5.35')
REPOS = [
    'https://maven.aliyun.com/repository/google',
    'https://maven.aliyun.com/repository/public',
    'https://dl.google.com/android/maven2',
    'https://repo1.maven.org/maven2',
]
MIN_SDK, TARGET_SDK = 21, 34
ANDROID = 'http://schemas.android.com/apk/res/android'
TOOLS_NS = 'http://schemas.android.com/tools'
POM = '{http://maven.apache.org/POM/4.0.0}'


def a(name):
    return f'{{{ANDROID}}}{name}'


def run(*cmd, **kw):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.exit(f'✗ {Path(str(cmd[0])).name} failed:\n{(r.stderr or r.stdout)[-4000:]}')
    return r.stdout


# ---------- Maven ----------

def fetch(path):
    """Downloads a Maven file once into android/.tools/m2."""
    local = TOOLS / 'm2' / path
    if local.exists():
        return local
    for repo in REPOS:
        try:
            with urllib.request.urlopen(f'{repo}/{path}', timeout=60) as r:
                data = r.read()
        except Exception:
            continue
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(data)
        return local
    return None


def artifact_path(g, art, v, ext):
    return f"{g.replace('.', '/')}/{art}/{v}/{art}-{v}.{ext}"


def version_key(v):
    return [int(x) if x.isdigit() else -1 for x in re.split(r'[.-]', v)]


def dependencies(g, art, v):
    f = fetch(artifact_path(g, art, v, 'pom'))
    if not f:
        sys.exit(f'✗ {g}:{art}:{v} not found in any Maven repository')
    pom = ET.parse(f).getroot()
    found = pom.find(POM + 'properties')
    props = {e.tag.replace(POM, ''): e.text for e in (found if found is not None else [])}
    out = []
    for d in pom.iter(POM + 'dependency'):
        if (d.findtext(POM + 'scope') or 'compile') not in ('compile', 'runtime') or d.findtext(POM + 'optional') == 'true':
            continue
        dv = d.findtext(POM + 'version') or ''
        if dv.startswith('${'):
            dv = props.get(dv[2:-1], '')
        m = re.match(r'^[\[(]([^,\])]+)', dv)  # [1.2.3] or [1.2,2.0): take the lower bound
        if m:
            dv = m.group(1)
        if dv:
            out.append((d.findtext(POM + 'groupId'), d.findtext(POM + 'artifactId'), dv))
    return out


def resolve(roots):
    """Newest requested version of everything reachable, like Gradle picks."""
    chosen = {(g, art): v for g, art, v in roots}
    while True:
        seen, changed, stack = set(), False, [(g, art) for g, art, _ in roots]
        while stack:
            key = stack.pop()
            if key in seen:
                continue
            seen.add(key)
            for dg, da, dv in dependencies(*key, chosen[key]):
                if (dg, da) not in chosen or version_key(dv) > version_key(chosen[(dg, da)]):
                    chosen[(dg, da)] = dv
                    changed = True
                stack.append((dg, da))
        if not changed:
            return sorted((g, art, chosen[(g, art)]) for g, art in seen)


def library_files(g, art, v):
    """An AAR (Android library) or a plain JAR."""
    return fetch(artifact_path(g, art, v, 'aar')) or fetch(artifact_path(g, art, v, 'jar'))


# ---------- manifest ----------

def base_manifest(cfg, version_code):
    perms = {p.upper() for p in cfg.get('permissions', [])} | {'INTERNET', 'POST_NOTIFICATIONS', 'USE_FULL_SCREEN_INTENT'}
    orientation = {'portrait': 'portrait', 'landscape': 'landscape'}.get(cfg.get('orientation'), 'unspecified')
    webview, splash = cfg.get('webview', {}), cfg.get('splashScreen', {})
    meta = {
        'nitron.backButton': webview.get('backButton', 'history'),
        'nitron.clearCacheOnStart': str(webview.get('clearCacheOnStart', False)).lower(),
        'nitron.splashBackground': splash.get('backgroundColor', '#FFFFFF'),
    }
    return f'''<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="{ANDROID}" package={quoteattr(cfg['packageId'])}
    android:versionCode="{version_code}" android:versionName={quoteattr(cfg['version'])}>
    <uses-sdk android:minSdkVersion="{MIN_SDK}" android:targetSdkVersion="{TARGET_SDK}" />
{''.join(f'    <uses-permission android:name="android.permission.{p}" />{chr(10)}' for p in sorted(perms))}
    <application android:label={quoteattr(cfg['name'])} android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher" android:hardwareAccelerated="true"
        android:usesCleartextTraffic="{str(cfg.get('network', {}).get('cleartext', False)).lower()}">
        <activity android:name="com.nicron.webview.MainActivity" android:exported="true" android:launchMode="singleTask"
            android:configChanges="orientation|keyboardHidden|keyboard|navigation|screenSize|screenLayout|smallestScreenSize|uiMode"
            android:screenOrientation="{orientation}">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
{''.join(f'            <meta-data android:name="{k}" android:value={quoteattr(v)} />{chr(10)}' for k, v in meta.items())}
        </activity>
        <service android:name="com.nicron.webview.ChatyMessagingService" android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="messages" />
    </application>
</manifest>
'''


def merge_manifests(base, libs, package):
    """What Gradle's manifest merger does, for what these libraries use."""
    ET.register_namespace('android', ANDROID)
    root = ET.fromstring(base)
    app = root.find('application')
    top = {}  # (tag, name) -> element, for permissions and features

    def clean(el):
        for e in el.iter():
            for k in list(e.attrib):
                if k.startswith(f'{{{TOOLS_NS}}}'):
                    del e.attrib[k]
                else:
                    e.attrib[k] = e.attrib[k].replace('${applicationId}', package)
        return el

    for el in root:
        if el.tag in ('uses-permission', 'permission', 'uses-feature'):
            top[(el.tag, el.get(a('name')))] = el
    for path in libs:
        lib = ET.parse(path).getroot()
        for el in lib:
            removed = el.get(f'{{{TOOLS_NS}}}node') == 'remove'
            if el.tag in ('uses-permission', 'uses-permission-sdk-23', 'permission', 'uses-feature'):
                key = (el.tag, (el.get(a('name')) or ET.tostring(el, encoding='unicode')).replace('${applicationId}', package))
                if not removed and key not in top:
                    top[key] = clean(el)
                    root.insert(list(root).index(app), el)
            elif el.tag == 'queries':
                queries = root.find('queries')
                if queries is None:
                    queries = ET.Element('queries')
                    root.insert(list(root).index(app), queries)
                for q in el:
                    clean(q)
                    if not any(ET.tostring(q) == ET.tostring(x) for x in queries):
                        queries.append(q)
            elif el.tag == 'application':
                for comp in el:
                    name = (comp.get(a('name')) or '').replace('${applicationId}', package)
                    same = [x for x in app if x.tag == comp.tag and x.get(a('name')) == name]
                    if comp.get(f'{{{TOOLS_NS}}}node') == 'remove':
                        for x in same:
                            app.remove(x)
                        continue
                    clean(comp)
                    if not same:
                        app.append(comp)
                        continue
                    # Declared by several libraries (Firebase's ComponentDiscoveryService): combine.
                    into = same[0]
                    for k, v in comp.attrib.items():
                        into.attrib.setdefault(k, v)
                    for child in comp:
                        if not any(ET.tostring(child) == ET.tostring(x) for x in into):
                            into.append(child)
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root, encoding='unicode')


def google_services(package):
    path = next((p for p in (ROOT / 'google-services.json', HERE / 'google-services.json') if p.exists()), None)
    if not path:
        sys.exit('✗ google-services.json is missing: download it from the Firebase console (Android app '
                 f'{package}) into the repo root.')
    gs = json.loads(path.read_text())
    client = next((c for c in gs['client'] if c['client_info']['android_client_info']['package_name'] == package), None)
    if not client:
        sys.exit(f'✗ google-services.json has no Android app with package {package}')
    info = gs['project_info']
    values = {
        'google_app_id': client['client_info']['mobilesdk_app_id'],
        'gcm_defaultSenderId': info['project_number'],
        'google_api_key': client['api_key'][0]['current_key'],
        'google_crash_reporting_api_key': client['api_key'][0]['current_key'],
        'project_id': info['project_id'],
        'google_storage_bucket': info.get('storage_bucket', ''),
    }
    rows = ''.join(f'    <string name="{k}" translatable="false">{escape(v)}</string>\n' for k, v in values.items())
    return f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n{rows}</resources>\n'


# ---------- build ----------

def main():
    for f in (AAPT2, ANDROID_JAR, SIGNER, APK):
        if not f.exists():
            sys.exit(f'✗ {f} is missing: run `npx nitron build` first.')
    cfg = json.loads((APP / 'nitron.config.json').read_text())
    package = cfg['packageId']
    major, minor, patch = (list(map(int, cfg['version'].split('.'))) + [0, 0])[:3]
    version_code = major * 10000 + minor * 100 + patch

    print('• resolving Firebase…')
    libs = resolve(FIREBASE)
    work = Path(tempfile.mkdtemp(prefix='chaty-apk-'))
    try:
        jars, manifests, res_dirs, packages = [], [], [], set()
        for g, art, v in libs:
            f = library_files(g, art, v)
            if not f:
                sys.exit(f'✗ couldn\'t download {g}:{art}:{v}')
            if f.suffix == '.jar':
                jars.append(f)
                continue
            out = work / 'aar' / f'{art}-{v}'
            with zipfile.ZipFile(f) as z:
                z.extractall(out)
            if (out / 'classes.jar').exists():
                jars.append(out / 'classes.jar')
            jars += sorted((out / 'libs').glob('*.jar')) if (out / 'libs').exists() else []
            manifests.append(out / 'AndroidManifest.xml')
            packages.add(ET.parse(out / 'AndroidManifest.xml').getroot().get('package'))
            if (out / 'res').exists() and any((out / 'res').iterdir()):
                res_dirs.append(out / 'res')
        print(f'  {len(libs)} libraries')

        # Resources: the launcher icons Nitron made, ours, google-services values.
        res = work / 'res'
        shutil.copytree(HERE / 'res', res)
        with zipfile.ZipFile(APK) as z:
            for name in z.namelist():
                if re.match(r'res/mipmap-[a-z]+(-v\d+)?/ic_launcher(_foreground)?\.png$', name):
                    dest = res / Path(name).relative_to('res')
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(z.read(name))
        (res / 'mipmap-anydpi-v26').mkdir(exist_ok=True)
        (res / 'mipmap-anydpi-v26' / 'ic_launcher.xml').write_text(
            f'<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="{ANDROID}">\n'
            '    <background android:drawable="@color/ic_launcher_background" />\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n</adaptive-icon>\n')
        (res / 'values').mkdir(exist_ok=True)
        icon_bg = cfg['icon'].get('background', '#FFFFFF') if isinstance(cfg.get('icon'), dict) else '#FFFFFF'
        (res / 'values' / 'colors.xml').write_text(
            f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">{icon_bg}</color>\n</resources>\n')
        (res / 'values' / 'google-services.xml').write_text(google_services(package))

        manifest = work / 'AndroidManifest.xml'
        manifest.write_text(merge_manifests(base_manifest(cfg, version_code), manifests, package))

        print('• resources…')
        compiled = [work / 'app-res.zip']
        run(AAPT2, 'compile', '--dir', res, '-o', compiled[0])
        for i, d in enumerate(res_dirs):
            out = work / f'lib-res-{i}.zip'
            run(AAPT2, 'compile', '--dir', d, '-o', out)
            compiled.append(out)
        gen = work / 'gen'
        linked = work / 'linked.apk'
        run(AAPT2, 'link', '-o', linked, '-I', ANDROID_JAR, '--manifest', manifest, '--auto-add-overlay',
            '--java', gen, '--extra-packages', ':'.join(sorted(packages - {package})),
            compiled[0], *[x for c in compiled[1:] for x in ('-R', c)])

        print('• compiling…')
        classes = work / 'classes'
        sources = [*HERE.joinpath('src').rglob('*.java'), *gen.rglob('*.java')]
        run('javac', '--release', '8', '-nowarn', '-Xlint:-options', '-encoding', 'UTF-8', '-d', classes,
            '-cp', os.pathsep.join(map(str, [ANDROID_JAR, *jars])), *sources)
        ours = work / 'ours.jar'
        with zipfile.ZipFile(ours, 'w') as z:
            for f in classes.rglob('*.class'):
                z.write(f, f.relative_to(classes))
        d8 = fetch(artifact_path(*D8, 'jar'))
        if not d8:
            sys.exit('✗ couldn\'t download d8 (com.android.tools:r8)')
        dex = work / 'dex'
        dex.mkdir()
        run('java', '-cp', d8, 'com.android.tools.r8.D8', '--release', '--min-api', MIN_SDK, '--lib', ANDROID_JAR,
            '--output', dex, ours, *jars)

        print('• packaging…')
        unsigned = work / 'unsigned.apk'
        names = set()
        with zipfile.ZipFile(unsigned, 'w', zipfile.ZIP_DEFLATED) as out:
            def put(name, data, store=False):
                if name not in names:
                    names.add(name)
                    out.writestr(zipfile.ZipInfo(name, (1981, 1, 1, 0, 0, 0)), data,
                                 zipfile.ZIP_STORED if store else zipfile.ZIP_DEFLATED)
            with zipfile.ZipFile(linked) as z:
                for name in z.namelist():
                    # Android needs resources.arsc uncompressed.
                    put(name, z.read(name), store=name == 'resources.arsc')
            for f in sorted(dex.glob('*.dex')):
                put(f.name, f.read_bytes())
            with zipfile.ZipFile(APK) as z:
                for name in z.namelist():
                    if name.startswith('assets/'):
                        put(name, z.read(name))
            # Files libraries read from the classpath (versions, service lists).
            for jar in jars:
                with zipfile.ZipFile(jar) as z:
                    for name in z.namelist():
                        if name.endswith(('/', '.class')) or re.match(r'META-INF/(MANIFEST\.MF|.*\.(SF|RSA|DSA|EC))$', name):
                            continue
                        put(name, z.read(name))

        signed = work / 'signed'
        run('java', '-jar', SIGNER, '--apks', unsigned, '--out', signed, '--allowResign', *release_key())
        result = next(signed.glob('*.apk'))
        shutil.copyfile(result, APK)
        dexes = len(list(dex.glob('*.dex')))
        print(f'✓ dist/app.apk {cfg["version"]} ({APK.stat().st_size // 1024} KB, {dexes} dex, '
              f'{"release key" if release_key() else "DEBUG key"})')
    finally:
        shutil.rmtree(work, ignore_errors=True)


def release_key():
    """Signing arguments from android/keystore.properties (kept out of git)."""
    props_file = HERE / 'keystore.properties'
    if not props_file.exists():
        print('⚠ No android/keystore.properties: signing with the public debug key.')
        return []
    props = dict(l.split('=', 1) for l in props_file.read_text().splitlines() if '=' in l and not l.startswith('#'))
    props = {k.strip(): v.strip() for k, v in props.items()}
    return ['--ks', HERE / props['storeFile'], '--ksAlias', props['keyAlias'],
            '--ksPass', props['storePassword'], '--ksKeyPass', props['keyPassword']]


if __name__ == '__main__':
    main()
