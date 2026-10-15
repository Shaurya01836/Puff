// Where Puff keeps its own files: ~/.puff by default, or $PUFF_HOME.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const puffHome = (): string => resolve(process.env.PUFF_HOME ?? join(homedir(), '.puff'));

/** The user's own configuration (agents, models, limits), shared by every project. */
export const userConfigPath = (): string => join(puffHome(), 'config.yaml');

/** The list of projects and which one is active. */
export const projectsPath = (): string => join(puffHome(), 'projects.json');
