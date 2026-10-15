// The demo project must be its own git repository (agents work in worktrees of it), but demo/shop-api
// lives inside Puff's own repo. This makes a pristine, separate copy to run agents on.
//
// It lives under the user's home (~/.puff/demo), not inside the Puff checkout, so an agent working
// there cannot wander up into Puff's own files, such as demo/TRAPS.md that lists the seeded traps.
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { puffHome } from '../paths';
import { git, removeLink } from './repo';

export { puffHome };

export const defaultDemoWorkspace = (): string => join(puffHome(), 'demo', 'shop-api');

export interface DemoWorkspace {
  path: string;
  /** node_modules was linked from the source copy, so tests can run without another install */
  linkedNodeModules: boolean;
}

/** Create (or with `force`, recreate) a pristine git repository from the demo source. */
export async function setupDemoWorkspace(opts: {
  source: string;
  dest?: string;
  force?: boolean;
}): Promise<DemoWorkspace> {
  const source = resolve(opts.source);
  const dest = resolve(opts.dest ?? defaultDemoWorkspace());
  if (!existsSync(join(source, 'package.json')))
    throw new Error(`${source} does not look like the demo project (no package.json)`);

  if (existsSync(dest)) {
    if (!opts.force)
      throw new Error(`${dest} already exists. Use --force to recreate it from the demo source.`);
    // Unlink node_modules first so deleting the workspace can never reach into the real one.
    await removeLink(join(dest, 'node_modules')).catch(() => {});
    await rm(dest, { recursive: true, force: true });
  }
  await mkdir(dest, { recursive: true });
  await cp(source, dest, {
    recursive: true,
    filter: (src) =>
      !/[\\/](node_modules|\.git|\.puff|dist)([\\/]|$)/.test(src.slice(source.length)),
  });
  await writeFile(join(dest, '.gitignore'), 'node_modules\n');

  const identity = ['-c', 'user.name=Puff', '-c', 'user.email=puff@localhost'];
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'shop-api: initial state'],
  ]) {
    const r = await git(args, dest, identity);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim()}`);
  }

  const nodeModules = join(source, 'node_modules');
  const linkedNodeModules = existsSync(nodeModules);
  if (linkedNodeModules) {
    await symlink(
      nodeModules,
      join(dest, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  return { path: dest, linkedNodeModules };
}
