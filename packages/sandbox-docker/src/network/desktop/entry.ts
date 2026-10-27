import { runDesktopVmObserverControl } from './controller.js';
import { DESKTOP_VM_CONFIG_ENV, parseDesktopVmObserverConfiguration } from './protocol.js';

export async function runDesktopVmRouteObserverHelper(): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new TypeError('The Desktop route observer requires Linux arm64.');
  const raw = process.env[DESKTOP_VM_CONFIG_ENV];
  if (raw === undefined || Buffer.byteLength(raw) > 4096) throw new TypeError('Missing bounded Desktop observer configuration.');
  const configuration = parseDesktopVmObserverConfiguration(JSON.parse(raw));
  await runDesktopVmObserverControl({ input: process.stdin, output: process.stdout, configuration });
}
