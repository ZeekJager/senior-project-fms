/**
 * Local stand-ins for notification providers (FMS-93): an SMTP server that keeps what it is sent, and an HTTP
 * server for the SMS gateway and Web Push services. Each can be told how to answer next, to test failures.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The message as sent: headers and body. */
  data: string;
}

/**
 * Plain SMTP without TLS or authentication (the provider is set to `tls: 'none'`). `rcptReply` answers RCPT TO,
 * `mailReply` MAIL FROM: '250 OK' by default; set '550 No such user' or '451 Try later' to fail.
 */
export async function smtpSink() {
  const mails: ReceivedMail[] = [];
  const replies = { mail: '250 OK', rcpt: '250 OK' };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current: ReceivedMail = { from: '', to: [], data: '' };
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 smtp-sink ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          mails.push(current);
          say(`250 OK queued as sink-${mails.length}`);
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') say('250 smtp-sink');
        else if (verb === 'MAIL') {
          current = { from: line.slice(10).trim(), to: [], data: '' };
          say(replies.mail);
        } else if (verb === 'RCPT') {
          if (replies.rcpt.startsWith('250')) current.to.push(line.slice(8).trim());
          say(replies.rcpt);
        } else if (verb === 'DATA') {
          inData = true;
          say('354 Go ahead');
        } else if (verb === 'QUIT') {
          say('221 Bye');
          socket.end();
          return;
        } else say('250 OK');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    mails,
    replies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * An HTTP server that keeps every request and answers with the next of `answers` (the last one again when they
 * run out): a status, a JSON body and headers.
 */
export async function httpRecorder(answers: { status: number; json?: unknown; headers?: Record<string, string> }[] = [{ status: 200 }]) {
  const received: ReceivedRequest[] = [];
  const queue = [...answers];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const answer = queue.length > 1 ? queue.shift()! : queue[0];
      res.writeHead(answer.status, { ...(answer.json === undefined ? {} : { 'content-type': 'application/json' }), ...answer.headers });
      res.end(answer.json === undefined ? undefined : JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    /** Answers from now on. */
    answer: (...next: { status: number; json?: unknown; headers?: Record<string, string> }[]) => queue.splice(0, queue.length, ...next),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
