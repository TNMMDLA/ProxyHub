import { createServer } from 'node:http';

let slow = false;
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/mode/slow') {
    slow = true;
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && request.url === '/mode/fast') {
    slow = false;
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const send = () => {
    if (request.url === '/small') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '5',
      });
      response.end('small');
      return;
    }
    if (request.url === '/download') {
      const chunk = Buffer.alloc(16 * 1024, 0x50);
      const chunks = 32;
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(chunk.length * chunks),
      });
      let sent = 0;
      const write = () => {
        if (sent >= chunks) {
          response.end();
          return;
        }
        sent += 1;
        if (response.write(chunk)) setImmediate(write);
        else response.once('drain', write);
      };
      write();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  };
  if (slow && ['/small', '/download'].includes(request.url ?? '')) {
    const timer = setTimeout(send, 60_000);
    request.once('close', () => clearTimeout(timer));
    return;
  }
  send();
});

server.listen(8080, '0.0.0.0');

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
