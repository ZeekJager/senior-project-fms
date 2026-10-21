/**
 * A provider's HTTP API for the integration gateway's tests (FMS-85): a local server whose answer to
 * each path the test sets (a status, a body, a delay, or no answer at all), and which records every
 * request it gets. Pair it with `mockProviderAdapter` and a provider row whose base_url is `url`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Answer {
  status?: number;
  body?: unknown;
  /** Milliseconds before answering. */
  delayMs?: number;
  /** Never answer (until the server closes). */
  hang?: boolean;
}

export interface MockProviderServer {
  url: string;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  answer(path: string, answer: Answer): void;
  close(): Promise<void>;
}

export async function startMockProvider(): Promise<MockProviderServer> {
  const answers = new Map<string, Answer>();
  const requests: MockProviderServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers });
    const answer = answers.get(path) ?? { status: 404, body: { error: 'no answer set' } };
    if (answer.hang) return;
    setTimeout(() => {
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body ?? {}));
    }, answer.delayMs ?? 0);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    answer: (path, answer) => answers.set(path, answer),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
