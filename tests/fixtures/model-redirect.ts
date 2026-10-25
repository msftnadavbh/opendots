import { createServer } from 'node:http';
import { once } from 'node:events';

export async function modelRedirect() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/redirect') {
      response.writeHead(307, { Location: '/target' });
      response.end();
    } else {
      response.writeHead(200);
      response.end('Bearer must not reach this redirect target.');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return {
    url: `http://127.0.0.1:${address.port}/redirect`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
