import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Real resource launcher proxy; faults the owned pipe while preserving native SDK and kernel policy. */
export async function mutationLauncher(root: string, mode: 'drop_receipt' | 'pause_ready') {
  const executable = join(root, `launcher-${mode}.mjs`), trace = join(root, `launcher-${mode}.jsonl`);
  await writeFile(executable, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const trace=${JSON.stringify(trace)}, mode=${JSON.stringify(mode)};
const child=spawn('/usr/bin/prlimit',process.argv.slice(2),{stdio:['pipe','pipe','pipe']});
const record=(kind)=>appendFileSync(trace,JSON.stringify({kind})+'\\n');
let input='',output='';
process.stdin.on('data',(chunk)=>{
  input+=chunk;
  let newline;
  while((newline=input.indexOf('\\n'))!==-1){
    const frame=JSON.parse(input.slice(0,newline));input=input.slice(newline+1);
    if(frame.kind==='dispatch')record('permit');
  }
  child.stdin.write(chunk);
});
process.stdin.on('end',()=>child.stdin.end());
child.stdin.on('error',()=>{});
child.stderr.pipe(process.stderr);
child.stdout.on('data',(chunk)=>{
  output+=chunk;
  let newline;
  while((newline=output.indexOf('\\n'))!==-1){
    const line=output.slice(0,newline);output=output.slice(newline+1);
    const frame=JSON.parse(line);record(frame.kind);
    if((mode==='drop_receipt'&&frame.kind==='mutation')||(mode==='pause_ready'&&frame.kind==='ready'))continue;
    process.stdout.write(line+'\\n');
  }
});
child.on('error',()=>{process.exitCode=1;});
child.on('close',(code)=>{if(output)process.stdout.write(output);process.exitCode=code??1;});
`, { mode: 0o700, flag: 'wx' });
  const events = async (): Promise<readonly string[]> => {
    let text: string;
    try { text = await readFile(trace, 'utf8'); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    return text.trim().split('\n').filter(Boolean).map((line) => {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== 'object' || !('kind' in value) || typeof value.kind !== 'string') throw new Error('Invalid launcher observation');
      return value.kind;
    });
  };
  return { executable, events, async waitReady() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await events()).includes('ready')) return;
      await delay(10);
    }
    throw new Error('The actual native worker did not reach mutation preflight.');
  } };
}
