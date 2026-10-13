import { readFile } from 'node:fs/promises';
import { openAcpInstallationStore } from '../../../src/node/install/index.js';
import type { AcpInstallPlan } from '../../../src/planning/contracts.js';

const [root, planPath] = process.argv.slice(2);
if (!root || !planPath) throw new Error('The store worker requires an explicit root and plan file.');
const plan = JSON.parse(await readFile(planPath, 'utf8')) as AcpInstallPlan;
const store = await openAcpInstallationStore({ root });
await store.install({ plan, expectedPlanDigest: plan.digest });
