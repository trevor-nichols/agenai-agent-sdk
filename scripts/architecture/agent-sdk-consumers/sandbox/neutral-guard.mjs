// ------------------------------------------------------------------------------------------------
//                neutral-guard.mjs - No process or network effects in neutral proof
// ------------------------------------------------------------------------------------------------

import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const unavailable = () => { throw new Error("The neutral installed sandbox proof must not enter a process or network operation."); };
for (const name of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync", "fork"]) childProcess[name] = unavailable;
for (const module of [http, https]) for (const name of ["request", "get"]) module[name] = unavailable;
net.connect = unavailable;
net.createConnection = unavailable;
tls.connect = unavailable;
globalThis.fetch = unavailable;
syncBuiltinESMExports();
