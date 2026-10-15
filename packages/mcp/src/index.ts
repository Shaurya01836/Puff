// Puff MCP server (stdio). Agents that support MCP (Claude Code, OpenCode) call these tools
// to read and write the shared graph memory. More tools land with each build phase
// (get_context, impact_of, record_decision, record_failure, record_solution, handoff, why).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect, graphName, graphStats, loadDotEnv, projectGraph } from '@puff/core';

loadDotEnv();

const project = process.env.PUFF_PROJECT;
if (!project) {
  console.error('PUFF_PROJECT is required (the project slug, e.g. shop_api)');
  process.exit(1);
}

const db = await connect();
const graph = projectGraph(db, project);

const server = new McpServer({ name: 'puff', version: '0.1.0' });

server.registerTool(
  'project_status',
  {
    title: 'Project memory status',
    description:
      'Counts of code and memory nodes (files, symbols, tasks, failures, decisions…) in the shared Puff graph for this project.',
  },
  async () => {
    if (!(await db.list()).includes(graphName(project))) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Graph ${graphName(project)} does not exist. Run puff init first.`,
          },
        ],
      };
    }
    const stats = await graphStats(graph);
    return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so diagnostics go to stderr.
console.error(`puff-mcp ready for ${graphName(project)}`);
