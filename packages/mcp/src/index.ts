// Puff MCP server (stdio). Agents that support MCP (Claude Code, OpenCode) call these tools
// to read and write the shared graph memory. The tools themselves live in ./tools.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect, graphName, loadConfig, loadDotEnv, projectGraph } from '@puff/core';
import { createPuffServer } from './tools';

loadDotEnv();

const project = process.env.PUFF_PROJECT;
if (!project) {
  console.error('PUFF_PROJECT is required (the project slug, e.g. shop_api)');
  process.exit(1);
}

const db = await connect();
if (!(await db.list()).includes(graphName(project))) {
  console.error(`Graph ${graphName(project)} does not exist. Run: npm run puff -- index <repo>`);
  process.exit(1);
}

const server = createPuffServer({
  graph: projectGraph(db, project),
  config: await loadConfig(process.env.PUFF_CONFIG),
  sessionId: process.env.PUFF_SESSION,
});

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so diagnostics go to stderr.
console.error(`puff-mcp ready for ${graphName(project)}`);
