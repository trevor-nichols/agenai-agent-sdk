// A separate controller process used only for the process-death experiment.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { activate } from './controller.mjs';

const [binary, engineId, stage, recordJson, effectPath] = process.argv.slice(2);
const coordinator = await activate(binary, engineId, { namespace: 'worker', profile: 'native-arm64' });
const record = JSON.parse(recordJson);
const waiting = () => new Promise(() => {});
const announce = (name, extra = {}) => process.stdout.write(`${JSON.stringify({ stage: name,
  helperPid: coordinator.holder.child.pid, generation: coordinator.record.generation, ...extra })}\n`);
if (stage !== 'generation') await coordinator.register(record);
if (stage === 'member_intent') {
  await coordinator.begin(record, async (value) => {
    await writeFile(effectPath, JSON.stringify(value));
    announce(stage);
    await waiting();
  });
} else if (['authorized', 'effect_entered', 'late_effect', 'settled'].includes(stage)) {
  await coordinator.begin(record, async () => {});
  if (stage !== 'authorized') {
    await coordinator.dispatch(async () => {
      await writeFile(effectPath, 'entered');
      if (stage === 'effect_entered') { announce(stage); await waiting(); }
      if (stage === 'late_effect') {
        const child = spawn(process.execPath, ['-e',
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late-effect-completed"), 700)', effectPath], { stdio: 'ignore' });
        announce(stage, { effectPid: child.pid, effectPath });
        await waiting();
      }
      return { id: 'synthetic-returned-id', fingerprint: 'synthetic-fingerprint' };
    });
    await coordinator.settle();
  }
}
if (stage === 'inheritance') {
  const independent = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  announce(stage, { independentPid: independent.pid });
} else if (stage !== 'member_intent' && stage !== 'effect_entered') announce(stage);
setInterval(() => {}, 1000);
