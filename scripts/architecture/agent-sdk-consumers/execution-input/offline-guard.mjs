// ------------------------------------------------------------------------------------------------
//                offline-guard.mjs - Deny networking for the installed execution-input proofs
// ------------------------------------------------------------------------------------------------

import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const denied = () => { throw new Error('Packed execution-input proof attempted network access.'); };
globalThis.fetch = denied;
globalThis.WebSocket = class { constructor() { denied(); } };
net.Socket.prototype.connect = denied;
net.connect = net.createConnection = tls.connect = dgram.createSocket = denied;
http.request = http.get = https.request = https.get = denied;
syncBuiltinESMExports();
