import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'vendor', 'uu-web');
const entry = path.join(directory, 'local-run.mjs');
try {
  await access(entry);
  await access(path.join(directory, 'backend', 'dist', 'app.js'));
} catch {
  console.error('本地 UU 网页主控尚未构建，请按 README 的首次准备步骤操作。');
  process.exit(1);
}
process.umask(0o077);
await mkdir(path.join(root, 'output'), { recursive: true });
const child = spawn(process.execPath, [entry], {
  cwd: directory,
  env: { ...process.env, HOST: '127.0.0.1', PORT: '18789',
    UURC_BACKEND_LOG_PATH: path.join(root, 'output', 'web-backend.log') },
  stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { child.kill(signal); });
}
