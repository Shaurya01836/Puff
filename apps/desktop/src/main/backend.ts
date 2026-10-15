import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackendInfo, GraphData, PuffApi } from '@puff/shared';
import { neighbourhood } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';
import {
  connect,
  exportGraph,
  graphName,
  indexRepo,
  initProjectGraph,
  loadConfig,
  loadDotEnv,
  read,
  slugify,
  type ProjectInfo,
} from '@puff/core';
import type { FalkorDB, Graph } from 'falkordb';

/** Parts of the API still served from mocks in live mode. Shrinks phase by phase. */
const STILL_MOCKED = ['tasks', 'sessions', 'memory feed', 'agents stats', 'savings'];

/** The Puff repo root: the nearest folder (from cwd or the app) that holds puff.config.yaml. */
function findRoot(appDir: string): string {
  for (const start of [process.cwd(), appDir]) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'puff.config.yaml'))) return dir;
      if (dirname(dir) === dir) break;
    }
  }
  return process.cwd();
}

/**
 * The PuffApi the main process serves over IPC.
 * Phase P1: the code graph and indexing are live from FalkorDB; everything else is still mocked.
 * If FalkorDB is unreachable the whole API falls back to mocks and says why.
 */
export async function createBackend(appDir: string): Promise<PuffApi> {
  const mock = createMockApi();
  const root = findRoot(appDir);
  loadDotEnv(join(root, '.env'));

  let db: FalkorDB;
  let graph: Graph;
  let project: ProjectInfo;
  try {
    const config = await loadConfig(join(root, process.env.PUFF_CONFIG ?? 'puff.config.yaml'));
    const repoPath = resolve(root, process.env.PUFF_REPO ?? 'demo/shop-api');
    project = {
      slug: slugify(process.env.PUFF_PROJECT ?? basename(repoPath)),
      name: basename(repoPath),
      repoPath,
    };
    db = await connect();
    graph = await initProjectGraph(db, project, config);
    const rows = await read<{ files: number }>(graph, 'MATCH (f:File) RETURN count(f) AS files');
    if ((rows[0]?.files ?? 0) === 0) await indexRepo(graph, project);
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[puff] live backend unavailable, using mocks: ${error}`);
    return {
      ...mock,
      async getBackendInfo(): Promise<BackendInfo> {
        return { ...(await mock.getBackendInfo()), error };
      },
    };
  }

  const info = (): BackendInfo => ({
    mode: 'live',
    projectId: project.slug,
    projectName: project.name,
    repoPath: project.repoPath,
    graphName: graphName(project.slug),
    mockParts: STILL_MOCKED,
  });

  return {
    ...mock,
    async getBackendInfo() {
      return info();
    },
    async openProject(repoPath: string) {
      const config = await loadConfig(join(root, process.env.PUFF_CONFIG ?? 'puff.config.yaml'));
      const abs = resolve(repoPath);
      project = { slug: slugify(basename(abs)), name: basename(abs), repoPath: abs };
      graph = await initProjectGraph(db, project, config);
      return { projectId: project.slug };
    },
    async indexProject() {
      const s = await indexRepo(graph, project);
      return { files: s.files, symbols: s.symbols, calls: s.calls };
    },
    async getGraph(_projectId, focusId, depth): Promise<GraphData> {
      const full = await exportGraph(graph);
      return focusId ? neighbourhood(full, focusId, depth) : full;
    },
  };
}
