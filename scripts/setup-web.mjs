import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const UPSTREAM_REPO = 'https://github.com/ofoz/uu_web.git';
const UPSTREAM_COMMIT = '6a118973f90ce55e448b596a19e40ac0a67c0fee';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor', 'uu-web');
const overlayDir = path.join(root, 'integration', 'uu-web');
const patchFile = path.join(overlayDir, 'upstream.patch');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令执行失败：${command} ${args.join(' ')} (exit ${result.status})`);
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

await mkdir(path.join(root, 'vendor'), { recursive: true });

if (!(await exists(path.join(vendorDir, '.git')))) {
  console.log(`Cloning ${UPSTREAM_REPO} into vendor/uu-web...`);
  run('git', ['clone', UPSTREAM_REPO, vendorDir], root);
  run('git', ['checkout', UPSTREAM_COMMIT], vendorDir);
} else {
  console.log('vendor/uu-web 已存在，跳过 clone。');
}

// Apply tracked upstream patch idempotently.
const checkApplied = spawnSync('git', ['apply', '--reverse', '--check', patchFile], { cwd: vendorDir, stdio: 'ignore' });
if (checkApplied.status !== 0) {
  console.log('Applying integration/uu-web/upstream.patch...');
  run('git', ['apply', patchFile], vendorDir);
} else {
  console.log('integration/uu-web/upstream.patch 已应用，跳过。');
}

// Copy local launcher and non-intrusive Agent bridge files.
await copyFile(path.join(overlayDir, 'local-run.mjs'), path.join(vendorDir, 'local-run.mjs'));
await copyFile(path.join(overlayDir, 'localAgentBridge.ts'), path.join(vendorDir, 'frontend', 'src', 'localAgentBridge.ts'));
await copyFile(
  path.join(overlayDir, 'localAgentBridge.test.ts'),
  path.join(vendorDir, 'frontend', 'tests', 'localAgentBridge.test.ts'),
);

if (!(await exists(path.join(vendorDir, 'node_modules')))) {
  console.log('Installing vendor/uu-web dependencies (--ignore-scripts)...');
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], vendorDir);
}

console.log('Building vendor/uu-web (shared -> backend -> frontend)...');
run('npm', ['run', 'build'], vendorDir);
console.log('Done! Run `npm run start:web` and `npm start`, then open http://127.0.0.1:18787/web-controller');
