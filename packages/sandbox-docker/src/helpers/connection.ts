// ------------------------------------------------------------------------------------------------
//                connection.ts - Entered TCP connection settlement under cancellation and close
// ------------------------------------------------------------------------------------------------

import type { Socket } from 'node:net';

export function awaitEgressConnection(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.reject(new Error('Egress connection closed before connecting.'));
  if (!socket.connecting && socket.remoteAddress !== undefined) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { socket.removeListener('connect', connected); socket.removeListener('error', failed); socket.removeListener('close', closed); };
    const connected = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const closed = () => failed(new Error('Egress connection closed before connecting.'));
    socket.once('connect', connected);
    socket.once('error', failed);
    socket.once('close', closed);
  });
}
