// Build the installer from a clean staging folder.
//
// electron-builder walks the npm workspace tree to find what to ship, and in this monorepo that never
// finishes (it runs out of memory). The app needs very little: the built `out/` folder plus the few
// packages the main process loads at runtime. So this script stages exactly that, in a folder outside
// the workspace, installs those packages at the versions the repo is tested with, and runs
// electron-builder there.
//
//   npm run package -w @puff/desktop            the Windows installer, in apps/desktop/release
//   npm run package -w @puff/desktop -- --dir   an unpacked app folder only (faster, for testing)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '../..');
// Outside the repository on purpose: inside it, electron-builder finds the workspace root again
const stage = join(tmpdir(), 'puff-installer-stage');
const output = join(desktop, 'release');
const dirOnly = process.argv.includes('--dir');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = readJson(join(desktop, 'package.json'));

function run(command, args, cwd, env = {}) {
  const res = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...env },
  });
  if (res.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${res.status})`);
}

/** The version npm resolved for a package in this repo, so the installer ships what was tested. */
function installedVersion(name) {
  for (const base of [join(desktop, 'node_modules'), join(repo, 'node_modules')]) {
    const file = join(base, name, 'package.json');
    if (existsSync(file)) return readJson(file).version;
  }
  throw new Error(`${name} is not installed. Run npm install first.`);
}

// 1. Build the app
run('npx', ['electron-vite', 'build'], desktop);

// 2. Stage: built files, icon, config, and a package.json with only what runs in the main process
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(desktop, 'out'), join(stage, 'out'), { recursive: true });
cpSync(join(desktop, 'build'), join(stage, 'build'), { recursive: true });
mkdirSync(join(stage, 'resources', 'bench'), { recursive: true });
cpSync(join(repo, 'puff.config.yaml'), join(stage, 'resources', 'puff.config.yaml'));
cpSync(join(repo, 'bench', 'results.json'), join(stage, 'resources', 'bench', 'results.json'));
// The grammars come from this package at build time, but it is not installed into the app: it breaks
// electron-builder's dependency scan, and only these three files are needed
mkdirSync(join(stage, 'resources', 'wasm'), { recursive: true });
for (const grammar of ['typescript', 'tsx', 'javascript']) {
  const file = `tree-sitter-${grammar}.wasm`;
  cpSync(
    join(repo, 'node_modules', 'tree-sitter-wasms', 'out', file),
    join(stage, 'resources', 'wasm', file),
  );
}

const dependencies = Object.fromEntries(
  Object.keys(pkg.dependencies).map((name) => [name, installedVersion(name)]),
);
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'puff',
      productName: 'Puff',
      version: pkg.version,
      description: pkg.description,
      author: pkg.author,
      type: 'module',
      main: './out/main/index.js',
      dependencies,
    },
    null,
    2,
  ),
);
// Same settings as electron-builder.yml, with paths that point into the stage
const config = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
  .replace('../../puff.config.yaml', 'resources/puff.config.yaml')
  .replace('../../bench/results.json', 'resources/bench/results.json')
  .replace('../../node_modules/tree-sitter-wasms/out', 'resources/wasm')
  .replace('output: release', `output: ${output.replaceAll('\\', '/')}`);
writeFileSync(join(stage, 'electron-builder.yml'), config);

// 3. Install the runtime packages (no dev tools, no lockfile, nothing from the workspace)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false'], stage);

// 4. Package
const electronVersion = installedVersion('electron');
// Run from the stage itself: started anywhere in the repo, electron-builder finds the workspace again
const builderCli = join(repo, 'node_modules', 'electron-builder', 'cli.js');
run(
  process.execPath,
  [
    builderCli,
    '--config',
    'electron-builder.yml',
    `--config.electronVersion=${electronVersion}`,
    ...(dirOnly ? ['--dir'] : ['--win', 'nsis']),
  ],
  stage,
);
console.log(`\nDone. Output is in ${output}`);
