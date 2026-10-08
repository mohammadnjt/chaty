// `npm run dev`: Go server on :8080 + Vite on :5177 (which proxies /api, /ws, /uploads).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = root + 'app';
const server = root + 'server';
const children = [];

if (!existsSync(app + '/node_modules')) {
  console.log('Installing web app dependencies…');
  const r = spawnSync('npm', ['install'], { cwd: app, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function run(name, color, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' } });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  }
  child.on('exit', (code) => {
    console.log(`${prefix}exited${code ? ` with code ${code}` : ''}`);
    stop(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('server', 36, 'go', ['run', '.'], server);
run('app', 35, 'npm', ['run', 'dev', '--', '--clearScreen', 'false'], app);
