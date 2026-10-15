// The projects Puff knows about, kept in ~/.puff/projects.json so the app and the CLI agree on them.
//
// Each project is a folder (its own git repository), a graph (`puff_<slug>`), and the few settings
// that differ per project (test command, linked folders). Everything else, such as which agents
// exist and their limits, is the user's own configuration and is shared.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { slugify } from '../ids';
import { projectsPath } from '../paths';

const entrySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  repoPath: z.string().min(1),
  addedAt: z.number(),
  testCommand: z.string().optional(),
  linkDirs: z.array(z.string()).optional(),
});
const registrySchema = z.object({
  version: z.literal(1),
  active: z.string().optional(),
  projects: z.array(entrySchema),
});

export type ProjectEntry = z.infer<typeof entrySchema>;
export type Registry = z.infer<typeof registrySchema>;

const empty = (): Registry => ({ version: 1, projects: [] });

/** Same folder, whatever the spelling (case on Windows, slashes, trailing separators). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const x = resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() : x;
  };
  return norm(a) === norm(b);
}

export async function loadRegistry(path = projectsPath()): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    throw err;
  }
  try {
    return registrySchema.parse(JSON.parse(text));
  } catch (err) {
    throw new Error(
      `${path} is not a valid project list (${(err as Error).message.slice(0, 120)}). ` +
        `Fix or delete it; your projects' graphs are not affected.`,
    );
  }
}

/** Write to a temporary file and rename, so a crash never leaves half a file. */
export async function saveRegistry(reg: Registry, path = projectsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  await rename(tmp, path);
}

/** A slug nobody else uses (two folders can share a name). */
export function uniqueSlug(reg: Registry, name: string, repoPath: string): string {
  const base = slugify(name);
  const owner = (slug: string) => reg.projects.find((p) => p.slug === slug);
  let slug = base;
  for (let n = 2; owner(slug) && !samePath(owner(slug)!.repoPath, repoPath); n++) {
    slug = `${base}_${n}`;
  }
  return slug;
}

export interface NewProject {
  repoPath: string;
  name?: string;
  testCommand?: string;
  linkDirs?: string[];
}

/** Register a folder. Adding the same folder again updates its settings instead of duplicating it. */
export async function addProject(
  input: NewProject,
  path = projectsPath(),
): Promise<{ entry: ProjectEntry; created: boolean }> {
  const reg = await loadRegistry(path);
  const repoPath = resolve(input.repoPath);
  const existing = reg.projects.find((p) => samePath(p.repoPath, repoPath));
  if (existing) {
    if (input.name) existing.name = input.name;
    if (input.testCommand !== undefined) existing.testCommand = input.testCommand || undefined;
    if (input.linkDirs !== undefined) existing.linkDirs = input.linkDirs;
    await saveRegistry(reg, path);
    return { entry: existing, created: false };
  }
  const name = (input.name ?? basename(repoPath)).trim();
  const entry: ProjectEntry = {
    slug: uniqueSlug(reg, name, repoPath),
    name,
    repoPath,
    addedAt: Date.now(),
    testCommand: input.testCommand || undefined,
    linkDirs: input.linkDirs,
  };
  reg.projects.push(entry);
  reg.active ??= entry.slug;
  await saveRegistry(reg, path);
  return { entry, created: true };
}

export interface ProjectPatch {
  name?: string;
  /** null clears the override */
  testCommand?: string | null;
  linkDirs?: string[] | null;
}

export async function updateProject(
  slug: string,
  patch: ProjectPatch,
  path = projectsPath(),
): Promise<ProjectEntry> {
  const reg = await loadRegistry(path);
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) throw new Error(`Unknown project ${slug}`);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error('A project needs a name');
    entry.name = patch.name.trim();
  }
  if (patch.testCommand !== undefined) entry.testCommand = patch.testCommand?.trim() || undefined;
  if (patch.linkDirs !== undefined) entry.linkDirs = patch.linkDirs ?? undefined;
  await saveRegistry(reg, path);
  return entry;
}

/** The graph is not touched here; deleting it is a separate, explicit choice. */
export async function removeProject(slug: string, path = projectsPath()): Promise<ProjectEntry> {
  const reg = await loadRegistry(path);
  const i = reg.projects.findIndex((p) => p.slug === slug);
  if (i < 0) throw new Error(`Unknown project ${slug}`);
  const [entry] = reg.projects.splice(i, 1);
  if (reg.active === slug) reg.active = reg.projects[0]?.slug;
  await saveRegistry(reg, path);
  return entry!;
}

export async function setActiveProject(slug: string, path = projectsPath()): Promise<ProjectEntry> {
  const reg = await loadRegistry(path);
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) throw new Error(`Unknown project ${slug}`);
  reg.active = slug;
  await saveRegistry(reg, path);
  return entry;
}

export const activeProject = (reg: Registry): ProjectEntry | undefined =>
  reg.projects.find((p) => p.slug === reg.active);

/** Find a project by slug, name or folder (what a person types on the command line). */
export function findProject(reg: Registry, ref: string): ProjectEntry | undefined {
  return (
    reg.projects.find((p) => p.slug === ref) ??
    reg.projects.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ??
    reg.projects.find((p) => samePath(p.repoPath, ref))
  );
}
