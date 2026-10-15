// Serve MCP tools over HTTP on this computer only, so an agent CLI (Claude Code) can call the tools of the
// application that started it, in the same process, against the same running team. The endpoint:
//   - listens on 127.0.0.1 only, on a random port
//   - needs a random bearer token, which exists only for this chat
//   - answers only POST /mcp, and only for the host name it is listening on (DNS rebinding)
// It is stateless: each request gets its own server object; the state lives in the tools' closures.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface McpHost {
  /** Where to connect, e.g. http://127.0.0.1:51234/mcp */
  url: string;
  /** Sent as `Authorization: Bearer <token>` */
  token: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

function reply(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'text/plain', ...headers });
  res.end(message);
}

const sameToken = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Start serving. `build` makes a fresh server for each request. */
export async function hostMcp(
  build: () => McpServer,
  opts: { token?: string } = {},
): Promise<McpHost> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  let port = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        return reply(res, 403, 'Wrong host');
      if (req.url?.split('?')[0] !== '/mcp') return reply(res, 404, 'Not found');
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token))
        return reply(res, 401, 'Unauthorized', { 'www-authenticate': 'Bearer' });
      if (req.method !== 'POST') return reply(res, 405, 'POST only', { allow: 'POST' });

      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return reply(res, 400, (err as Error).message);
      }
      const mcp = build();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: Error) => {
      if (!res.headersSent) reply(res, 500, err.message);
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
