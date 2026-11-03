import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import { createCoordinatedDockerSandboxBackend } from '../../src/index.js';
import { createDockerDesktopRecoveryController } from '../../src/node/desktopRecovery/controller.js';
import { createDockerDesktopRouteAuthority } from '../../src/node/desktopRouteAuthority.js';
import { readDesktopCoordinatorSourceDigest } from '../../src/node/prepareDesktopCoordinator.js';
import { readDesktopRecoveryProfileDigest, readDesktopRecoverySourceDigest } from '../../src/node/desktopRecovery/preparation.js';
import { parseCoordinatorSnapshot } from '../../src/network/desktop/coordinator/journal/schema.js';
import { createRecoveryEnvelope, planCleanupTransition, planHelperReplacement, transitionRecovery } from '../../src/network/desktop/coordinator/administrativeRecovery/plans.js';
import { encodeRecoveryEnvelope, parseRecoveryEnvelope } from '../../src/network/desktop/coordinator/administrativeRecovery/schema.js';
import { FIRST_SUCCESSOR_PROFILE, FIRST_SUCCESSOR_SOURCE, PREVIOUS_RECOVERY_PROFILE, PREVIOUS_RECOVERY_SOURCE } from '../../src/network/desktop/coordinator/administrativeRecovery/helperSuccession.js';
import { rawDigest } from '../../src/network/desktop/coordinator/administrativeRecovery/scalars.js';
import { RecoveryNativeOwner } from '../../src/node/desktopRecovery/native/owner.js';
import { openPreparedExecutable } from '../../src/node/preparedExecutable.js';
import { nativeAttemptRefSchema } from '../../src/network/desktop/coordinator/administrativeRecovery/receipts.js';
import type { RecoveryEnvelope } from '../../src/network/desktop/coordinator/administrativeRecovery/schema.js';
import type { DockerDesktopRecoveryHelper } from '../../src/node/desktopRecovery/contracts.js';
import { RestorationClassifier } from '../../src/node/desktopRecovery/restoration/classifier.js';
import { captureRecoveryEngine, recoveryNativeFactsDigest } from '../../src/node/desktopRecovery/restoration/engine.js';
import { RecoveryEvidence } from '../../src/node/desktopRecovery/evidence.js';
import { barrierAcceptanceDecisionSchema, recoveryDecisionBinding } from '../../src/network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import type { BarrierAcceptanceDecision } from '../../src/network/desktop/coordinator/administrativeRecovery/sdkDecisions.js';
import { DockerEngine } from '../../src/engine/client.js';
import { DockerApi } from '../../src/resources/api.js';
import type { DockerDesktopRecoveryControllerOptions } from '../../src/node/desktopRecovery/contracts.js';
import { desktopCoordinatorLifecycleFixture } from './desktopCoordinatorLifecycle.js';
import { desktopVmDocument } from './desktopObservation.js';
import { gate, sandboxRequest } from './engine.js';

export type RecoveryControllerFault = 'none' | 'before_open_response' | 'before_conversion_commit' | 'before_terminal_commit' | 'after_clean_commit' | 'after_terminal_manifest' | 'pause_conversion' | 'pause_destroyed' | 'pause_finished' | 'late_restore_error' | 'after_stopped_fact' | 'after_finished_fact' | 'before_bind_attempt' | 'after_outcome_fact' | 'before_helper_adoption_commit' | 'after_helper_adoption_commit' | 'pause_helper_adoption' | 'corrupt_origin_archive';
interface PeerEvent { readonly command: string; readonly pid?: number }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Real public enrollment/cleanup, Unix HTTP and prepared-process I/O; immutable slots store SDK-produced bytes. */
export async function desktopRecoveryControllerFixture(fault: RecoveryControllerFault = 'none', originalCut: 'planned' | 'identified' | 'unknown_compute' = 'planned') {
  let offline = false;
  let occupied: string | undefined;
  let containerList: () => readonly unknown[] = () => [];
  let adaptContainers = () => {};
  const source = await desktopCoordinatorLifecycleFixture('normal', { async handleRequest(input) {
    adaptContainers();
    if (offline) { input.response.destroy(); return true; }
    const json = (value: unknown, status = 200) => { input.response.writeHead(status, { 'content-type': 'application/json' }); input.response.end(JSON.stringify(value)); return true; };
    if (input.path === '/version') return json({ Version: '29.1.2', ApiVersion: '1.52', MinAPIVersion: '1.44',
      GitCommit: 'de45c2a', Os: 'linux', Arch: 'arm64', KernelVersion: '6.12.54-linuxkit' });
    if (input.path === '/info') return json({ ID: 'daemon-unit-1', Name: 'docker-desktop', KernelVersion: '6.12.54-linuxkit',
      OSType: 'linux', Architecture: 'aarch64', OperatingSystem: 'Docker Desktop', CgroupVersion: '2', CgroupDriver: 'cgroupfs',
      DockerRootDir: '/var/lib/docker', Driver: 'overlayfs', DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
      LiveRestoreEnabled: false, ServerVersion: '29.1.2', SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
      MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true });
    if (input.path === '/v1.52/containers/json') return json(containerList());
    if (originalCut === 'unknown_compute' && input.method === 'POST' && input.path === '/v1.52/containers/create'
      && new URL(input.request.url ?? '/', 'http://fixture.invalid').searchParams.get('name')?.endsWith('-compute')) {
      input.response.destroy(); return true;
    }
    if (occupied !== undefined && input.method === 'GET' && input.path === `/v1.52/containers/${encodeURIComponent(occupied)}/json`) {
      return json({ Id: 'f'.repeat(64), Name: `/${occupied}` });
    }
    return false;
  } }, originalCut === 'unknown_compute' ? {
    vm: (options) => desktopVmDocument({ ...options, bridgeIPv4: { address: '10.240.0.0', gateway: '10.240.0.1', broadcast: '10.240.0.15', prefix: 28 } }),
    network: (network) => {
      if (Reflect.get(network, 'Driver') !== 'bridge') return network;
      const containers = Object.fromEntries(Object.entries(network.Containers).map(([id, entry]) => {
        assert(entry !== null && typeof entry === 'object');
        return [id, { ...entry, IPv4Address: '10.240.0.2/28' }];
      }));
      const endpoints = Object.keys(containers).length;
      return { ...network, IPAM: { Driver: 'default', Options: null, Config: [{ Subnet: '10.240.0.0/28', Gateway: '10.240.0.1' }] },
        Containers: containers, Status: { IPAM: { Subnets: { '10.240.0.0/28': { IPsInUse: 3 + endpoints, DynamicIPsAvailable: 13 - endpoints } } } } };
    },
  } : undefined);
  let releaseStartup: (() => void) | undefined;
  try {
  containerList = () => [...source.containers.values()].map((container) => ({ Id: container.Id, Names: [container.Name], State: container.State.Status }));
  if (originalCut === 'unknown_compute') adaptContainers = () => {
    for (const container of source.containers.values()) for (const [name, attachment] of Object.entries(container.NetworkSettings.Networks)) {
      if (name !== 'host' && name !== 'none') {
        const network = [...source.networks].find(([id, entry]) => id === name || Reflect.get(entry, 'Name') === name);
        if (network !== undefined) {
          attachment.NetworkID = container.State.Status === 'created' ? '' : network[0];
          container.HostConfig.NetworkMode = network[0];
        }
        attachment.IPAddress = '10.240.0.2'; attachment.IPPrefixLen = 28; attachment.Gateway = '10.240.0.1';
      }
    }
  };
  const original = source.createOwner();
  const capability = await original.activate();
  const configured = source.options(); assert(configured.egress);
  assert(configured.egress.routeAuthority.kind === 'local_docker_desktop');
  const memberConfiguration = { ...configured, profile: 'desktop-apple-virtualization-native-arm64' as const,
    egress: { ...configured.egress, routeAuthority: configured.egress.routeAuthority,
      control: { heartbeatMs: 1000, leaseTimeoutMs: 60_000 } } };
  const backend = createCoordinatedDockerSandboxBackend({ ...memberConfiguration, coordinator: capability });
  const entered = gate(); const release = gate();
  releaseStartup = () => release.resolve();
  const reservation = backend.reserve(sandboxRequest({ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }),
    { kind: 'persisted', async persist(record) {
      if (originalCut !== 'unknown_compute' && record.phase === 'starting' && (originalCut === 'planned'
        || record.resources.some((resource) => resource.role === 'route_observer' && resource.identity.kind === 'identified'))) {
        entered.resolve(); await release.promise;
      }
    } });
  const starting = reservation.start(); void starting.catch(() => {});
  let originalFailure: unknown;
  if (originalCut === 'unknown_compute') await starting.then(() => assert.fail('Original unknown compute unexpectedly started.'), (cause: unknown) => { originalFailure = cause; });
  else await Promise.race([entered.promise, starting.then(() => assert.fail('Original startup bypassed its persisted boundary.'))]);
  const originalSnapshot = parseCoordinatorSnapshot(JSON.stringify(await source.current()));
  await source.terminateHolder(); release.resolve(); await starting.catch(() => {});
  await original.close().catch(() => {});
  if (originalCut === 'unknown_compute' && !source.effects.some((effect) => effect.method === 'POST'
    && effect.path === '/v1.52/containers/create' && effect.body !== null && typeof effect.body === 'object'
    && 'Labels' in effect.body && effect.body.Labels !== null && typeof effect.body.Labels === 'object'
    && Reflect.get(effect.body.Labels, 'ai.agen.sandbox.role') === 'compute')) {
    throw new Error('Original public startup failed before its intended compute create boundary.', { cause: originalFailure });
  }
  if (originalCut !== 'unknown_compute') assert.equal(source.effects.filter((effect) => effect.method === 'POST' && effect.path === '/v1.52/containers/create').length,
    originalCut === 'planned' ? 0 : 1, 'Original fixture reaches only its selected public ownership boundary.');
  if (originalSnapshot.generation.kind !== 'dirty') assert.fail('Public enrollment did not create its original dirty generation.');
  const member = originalSnapshot.generation.members[0]; assert(member);
  const originalObserver = member.roles.find((role) => role.role === 'route_observer');
  const returnedContainerId = originalObserver?.presence.kind === 'possibly_present' ? originalObserver.presence.returnedId
    : originalObserver?.presence.kind === 'present' ? originalObserver.presence.id : undefined;
  const directory = await realpath(source.spillDirectory);
  const currentPath = join(directory, 'coordinator-current.json');
  const storePath = join(directory, 'recovery-slots.json');
  const tracePath = join(directory, 'recovery-events.jsonl');
  const scriptPath = join(directory, 'recovery-peer.mjs');
  const executablePath = join(directory, 'recovery-peer');
  const faultPath = join(directory, 'recovery-fault');
  const releasePath = join(directory, 'recovery-release');
  const tempPath = join(directory, 'recovery-next');
  const lifecyclePath = join(directory, 'simulated-lifecycle');
  const epochPath = join(directory, 'recovery-issuer-epoch.json');
  await writeFile(faultPath, fault);
  const components = JSON.stringify({ appVersion: '4.54.0', buildNumber: '212467', engineVersion: '29.1.2', desktopCliVersion: 'v0.2.0', linuxVersion: 'v6.12.54' });
  const settings = '{"Cpus":4}';
  const profileDigest = (await readDesktopRecoveryProfileDigest()).slice(7);
  const recoverySourceDigest = (await readDesktopRecoverySourceDigest()).slice(7);
  const script = String.raw`
import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const paths = ${JSON.stringify({ currentPath, storePath, tracePath, faultPath, releasePath, tempPath, lifecyclePath, executablePath, epochPath })};
const engineKey = ${JSON.stringify(originalSnapshot.engineKey.slice(7))};
const endpoint = ${JSON.stringify(source.endpoint.slice(7))};
const metadata = ${JSON.stringify({ components, settings })};
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async path => { try { await stat(path); return true; } catch(e) { if(e.code==='ENOENT')return false;throw e; } };
const trace = command => appendFile(paths.tracePath,JSON.stringify({command,pid:process.pid})+'\n');
const reply = value => new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',e=>e?reject(e):resolve()));
let text = await readFile(paths.currentPath,'utf8');
let store = await exists(paths.storePath)?JSON.parse(await readFile(paths.storePath,'utf8')):undefined;
let clock=BigInt(store?.clock??'1000000'),attempt,armedAt,history,last,phase='idle',spans=[],lateRestoreError=false,pendingOutcome=false;
const save = ()=>{store.clock=String(clock);return writeFile(paths.storePath,JSON.stringify(store));};
const receipt = (kind,scope,text) => {
 const body=Buffer.from(text);let header;
 if(kind==='origin_archive'||kind==='terminal_archive')header=Buffer.from('AGENAI-SNAPSHOT-1\n'+engineKey+'\n'+hash(body)+'\n');
 else {header=Buffer.alloc(512);header.write('AGENAI-RECOVERY-1\n'+engineKey+'\n'+store.recoveryKey+'\n'+kind+'\n'+scope+'\n'+body.length+'\n'+hash(body)+'\n');}
 const bytes=Buffer.concat([header,body]);return{kind:'receipt',recordKind:kind,scope,digest:hash(bytes),bytes:bytes.length,text};
};
const put = async (kind,scope,text) => {
 const key=kind+':'+scope;const previous=store.slots[key];
 if(previous!==undefined&&previous!==text)throw Error('Immutable slot conflict');
 store.slots[key]=text;await save();return receipt(kind,scope,text);
};
const epoch=await exists(paths.epochPath)?JSON.parse(await readFile(paths.epochPath,'utf8')):undefined;
const profileDigest=epoch?.profileDigest??${JSON.stringify(profileDigest)};
const issuer={sourceDigest:epoch?.sourceDigest??${JSON.stringify(recoverySourceDigest)},executableSha256:hash(await readFile(epoch?.executablePath??paths.executablePath))};
const lifecycle=async()=>await exists(paths.lifecyclePath)?readFile(paths.lifecyclePath,'utf8'):'initial';
async function currentFacts(){
 const socket=await lstat(endpoint,{bigint:true});const image='1'.repeat(64);const uid=process.getuid();
 const replacement=await lifecycle()==='started';const base=replacement?200:100;
 return{profileDigest,hostBoot:'11111111-1111-4111-8111-111111111111',uid,continuousNs:String(clock),
  images:['backend','virtualization','build','desktop_cli','docker_cli'].map(role=>({role,sha256:image,identifier:'fixture',team:'fixture'})),
  processes:['backend','virtualization'].map((role,index)=>({role,pid:base+index,uid,parentPid:1,processGroup:base+index,startSeconds:replacement?'2':'1',startMicroseconds:'0',pidVersion:null,imageSha256:image})),
  peer:{pid:base,pidVersion:1,uid,device:String(socket.dev),inode:String(socket.ino)},
  store:{parentDevice:'1',parentInode:'2',device:'1',inode:'3',uid:String(uid),mode:'384',birthSeconds:'1',birthNanoseconds:'0'},
  metadata:Object.fromEntries(Object.entries(metadata).map(([source,value])=>[source,{sha256:hash(value),bytes:Buffer.byteLength(value)}]))};
}
async function nativeFact(kind,body){
 clock+=10n;
 const common={format:'agenai.desktop-recovery-native-fact.v1',engineKey,authorityId:store.authorityId,generationId:store.generationId,
  recoveryKey:store.recoveryKey,attempt,originFrameDigest:store.originFrameDigest,canonicalPayloadSha256:hash(text),
  claim:{rootDevice:'3',rootInode:'4',lockDevice:'5',lockInode:'6'},previousHistory:history,previous:last??null,issuer,
  profileDigest,hostBoot:'11111111-1111-4111-8111-111111111111',uid:process.getuid(),
  startedContinuousNs:String(armedAt),finishedContinuousNs:String(clock),kind};
 const extra=typeof body==='function'?await body():body;
 const result=await put(kind,String(attempt),JSON.stringify({...common,...extra}));
 last={kind,attempt,sha256:result.digest};return result;
}
const startup=Buffer.from([
 {component:'kmsg',level:'info',msg:'Linux version 6.12.54-linuxkit (scripted protocol fixture)'},
 {component:'kmsg',level:'info',msg:'Kernel command line: init=/initd com.docker.VMID=22222222-2222-4222-8222-222222222222'},
 {component:'containerd',level:'info',msg:'starting containerd',version:'v2.2.0',revision:'1c4457e00facac03ce1d75f7b6777a7a851e5c41'},
 ...['containerd is ready','adding process 280 to /sys/fs/cgroup/restricted','Starting up','Loading containers: start.','Restoring containers: start.',
 'Loading containers: done.','Daemon has completed initialization','API listen on /var/run/docker.raw.sock'].map(msg=>({component:'dockerd',level:'info',msg}))
].map(value=>JSON.stringify(value)).join('\n')+'\n');
const physical={stateDevice:'1',stateInode:'2'};
await trace('OPEN');
if(await readFile(paths.faultPath,'utf8')==='before_open_response')process.exit(70);
await reply({kind:'opened',initial:'existing',rootDevice:'3',rootInode:'4',lockDevice:'5',lockInode:'6',...physical,pendingTemp:await exists(paths.tempPath)});
let closing=false;
async function command(line,payload){
 const [name,...args]=line.split(' ');await trace(name);
 if(name==='READ')return reply({kind:'snapshot',text,digest:hash(text),...physical,pendingTemp:await exists(paths.tempPath)});
 if(name==='CHECK')return reply({kind:'checked',fenced:false});
 if(name==='CLEANUP')return reply({kind:'cleanup'});
 if(name==='DISCARD_TEMP'){await rm(paths.tempPath,{force:true});return reply({kind:'discarded'});}
 if(name==='BIND_EXISTING'){
  if(args[2]!==hash(text))throw Error('Wrong current digest');
  return reply(store?{kind:'bound_existing',recoveryKey:store.recoveryKey,originFrameDigest:store.originFrameDigest,originRawDigest:store.originRawDigest}:{kind:'absent'});
 }
 if(name==='BIND_ORIGIN'){
  if(args[4]!==hash(text))throw Error('Wrong original digest');
  store??={authorityId:args[0],generationId:args[1],recoveryKey:args[2],originFrameDigest:args[3],originRawDigest:hash(text),slots:{}};
  await put('origin_archive','generation',text);await save();
  return reply({kind:'bound_existing',recoveryKey:store.recoveryKey,originFrameDigest:store.originFrameDigest,originRawDigest:store.originRawDigest});
 }
 if(name==='BIND'){
  if(pendingOutcome)return reply({kind:'failure',reason:'native_publication_pending',errno:22,claim:'held'});
  if(await readFile(paths.faultPath,'utf8')==='before_bind_attempt'){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'evidence_directory_sync',errno:5,claim:'held'});
  }
  if(args[5]!==hash(text))throw Error('Wrong prepared canonical digest');
  attempt=Number(args[3]);history=args[6]==='none'?{kind:'none'}:{kind:args[6],attempt:Number(args[7]),sha256:args[8]};
  phase='bound';last=undefined;armedAt=clock;return reply({kind:'bound'});
 }
 if(name==='ARM'){
  if(phase!=='bound')throw Error('Overlapping native arm');armedAt=clock;spans=[];
  await nativeFact('admission',async()=>({facts:await currentFacts()}));
  const facts=await currentFacts();phase='armed';
  return reply(await nativeFact('armed',{producers:facts.processes,watchCount:facts.processes.length,
   deadlineContinuousNs:String(armedAt+600000000000n),logSources:[{source:'init',sourceIdentity:'log-init',initialOffset:'0'},{source:'console',sourceIdentity:'log-console',initialOffset:'0'}]}));
 }
 if(name==='OBSERVE_STOPPED'){
  if(phase==='stopped')return reply(receipt('stopped',String(attempt),store.slots['stopped:'+attempt]));
  if(phase!=='armed'||await lifecycle()!=='stopped')return reply({kind:'failure',reason:'stopped_interval',errno:22,claim:'held'});
  const facts=await currentFacts();phase='stopped';
  const stopped=await nativeFact('stopped',{joined:facts.processes,completeCensuses:2,endpoint:'not_serving'});
  if(await readFile(paths.faultPath,'utf8')==='after_stopped_fact'){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'receipt_publication_sync',errno:5,claim:'held'});
  }
  return reply(stopped);
 }
 if(name==='READ_LOG'){
  const observed=phase==='armed'||phase==='stopped';const source=args[0];
  const bytes=observed?(source==='init'&&lateRestoreError?Buffer.from(JSON.stringify({component:'dockerd',level:'error',msg:'failed to restore container'})+'\n')
   :source==='init'&&await lifecycle()==='started'&&spans.length===0?startup:Buffer.alloc(0))
   :Buffer.from('{}\n'+JSON.stringify({msg:'Kernel command line: com.docker.VMID=33333333-3333-4333-8333-333333333333'})+'\n');
  if(source==='init')lateRestoreError=false;
  const start=observed&&source==='init'&&spans.length?startup.length:0;const end=start+bytes.length;
  const sequence=bytes.length&&observed?spans.length+1:Math.max(1,spans.length);
  const span={source,sourceIdentity:'log-'+source,sequence,start:String(start),end:String(end),sha256:hash(bytes)};
  if(bytes.length&&observed)spans.push(span);
  return reply({kind:'log_bytes',phase:observed?'observed':'baseline',...span,bytesBase64:bytes.toString('base64'),done:true});
 }
 if(name==='FINISH_FACTS'){
  if(phase==='finished')return reply(receipt('finished',String(attempt),store.slots['finished:'+attempt]));
  if(phase!=='stopped'||await lifecycle()!=='started'||spans.length===0)throw Error('Incomplete native lifecycle');
  if(await readFile(paths.faultPath,'utf8')==='late_restore_error'){
   await writeFile(paths.faultPath,'none');lateRestoreError=true;return reply({kind:'failure',reason:'unread_log_bytes',errno:22,claim:'held'});
  }
  phase='finished';const finished=await nativeFact('finished',async()=>({facts:await currentFacts(),spans,spanManifestSha256:hash(JSON.stringify(spans))}));
  if(await readFile(paths.faultPath,'utf8')==='after_finished_fact'){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'receipt_publication_sync',errno:5,claim:'held'});
  }
  if(await readFile(paths.faultPath,'utf8')==='pause_finished'){
   await writeFile(paths.faultPath,'none');await trace('FINISHED_PAUSED');while(!await exists(paths.releasePath))await delay(5);
  }
  return reply(finished);
 }
 if(name==='ABANDON'){
  const accepted=store.slots['barrier_acceptance:'+attempt];if(accepted!==undefined)return reply(receipt('barrier_acceptance',String(attempt),accepted));
  const existing=store.slots['outcome:'+attempt];if(existing!==undefined){pendingOutcome=false;phase='ended';return reply(receipt('outcome',String(attempt),existing));}
  const previous=last;phase='ended';const outcome=await nativeFact('outcome',{outcome:'abandoned',reason:'caller',lastCompleted:previous??null});
  if(await readFile(paths.faultPath,'utf8')==='after_outcome_fact'){
   await writeFile(paths.faultPath,'none');pendingOutcome=true;return reply({kind:'failure',reason:'receipt_publication_sync',errno:5,claim:'held'});
  }
  return reply(outcome);
 }
 if(name==='READ_RECEIPT'){
  const found=store.slots[args[0]+':'+args[1]];
  if(args[0]==='origin_archive'&&await readFile(paths.faultPath,'utf8')==='corrupt_origin_archive')return reply(receipt(args[0],args[1],found+'\n'));
  return reply(found===undefined?{kind:'absent'}:receipt(args[0],args[1],found));
 }
 if(name==='ARCHIVE')return reply(await put(args[0]==='origin'?'origin_archive':'terminal_archive','generation',text));
 if(name==='SDK_DECISION'){
  const result=await put(args[0],args[1],payload.toString('utf8'));
  if(args[0]==='generation_terminal'&&await readFile(paths.faultPath,'utf8')==='after_terminal_manifest'){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'publication_sync',errno:5,claim:'held'});
  }
  return reply(result);
 }
 if(name==='READ_METADATA'){const body=Buffer.from(metadata[args[0]]);return reply({kind:'metadata_bytes',source:args[0],sha256:hash(body),bytes:body.length,bytesBase64:body.toString('base64')});}
 if(name==='OBSERVE_ADMISSION'||name==='OBSERVE_CURRENT_PEER'){
  return reply({kind:name==='OBSERVE_ADMISSION'?'admission':'current_peer',facts:await currentFacts()});
 }
 if(name==='COMMIT'){
  const proposed=payload.toString('utf8');const value=JSON.parse(proposed);const selected=await readFile(paths.faultPath,'utf8');
  const recovery=/^agenai[.]docker-desktop-recovery[.]v[123]$/.test(value.format);
  const priorFormat=JSON.parse(text).format;
  const adoption=value.format==='agenai.docker-desktop-recovery.v2'&&priorFormat==='agenai.docker-desktop-recovery.v1'
   ||value.format==='agenai.docker-desktop-recovery.v3'&&priorFormat==='agenai.docker-desktop-recovery.v2';
  if((selected==='pause_conversion'&&recovery)||(selected==='pause_destroyed'&&recovery&&JSON.stringify(value).includes('"destroyed"'))||(selected==='pause_helper_adoption'&&adoption)){
   await writeFile(paths.faultPath,'none');await trace('PAUSED');while(!await exists(paths.releasePath))await delay(5);
  }
  if((selected==='before_conversion_commit'&&recovery&&JSON.parse(text).format==='agenai.docker-desktop-coordinator.v1')
    ||(selected==='before_terminal_commit'&&recovery&&value.phase.kind==='terminal_ready')||(selected==='before_helper_adoption_commit'&&adoption)){
   await writeFile(paths.faultPath,'none');await writeFile(paths.tempPath,proposed);return reply({kind:'failure',reason:'snapshot_write',errno:5,claim:'held'});
  }
  await writeFile(paths.tempPath,proposed);await rename(paths.tempPath,paths.currentPath);text=proposed;
  if(selected==='after_helper_adoption_commit'&&adoption){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'publication_sync',errno:5,claim:'held'});
  }
  if(selected==='after_clean_commit'&&!recovery&&value.generation.kind==='clean'){
   await writeFile(paths.faultPath,'none');return reply({kind:'failure',reason:'publication_sync',errno:5,claim:'held'});
  }
  return reply({kind:'committed',digest:hash(payload),...physical});
 }
 if(name==='CLOSE'){await reply({kind:'closed'});closing=true;return;}
 throw Error('Unexpected recovery fixture command '+name);
}
let pending=Buffer.alloc(0),payloadLine,payloadLength;
for await(const chunk of process.stdin){pending=Buffer.concat([pending,chunk]);for(;;){
 if(payloadLength!==undefined){if(pending.length<payloadLength+1)break;if(pending[payloadLength]!==10)throw Error('Payload terminator');const body=pending.subarray(0,payloadLength);pending=pending.subarray(payloadLength+1);const line=payloadLine;payloadLength=undefined;await command(line,body);}
 else {const index=pending.indexOf(10);if(index<0)break;const line=pending.subarray(0,index).toString('ascii');pending=pending.subarray(index+1);if(/^(?:COMMIT|SDK_DECISION) /.test(line)){payloadLine=line;payloadLength=Number(line.split(' ').at(-1));}else await command(line);}
 if(closing)break;}if(closing)break;
}
await trace('EXIT');
`;
  await writeFile(scriptPath, script, { mode: 0o600 });
  const executable = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`;
  await writeFile(executablePath, executable, { mode: 0o700 });
  const originalPath = join(directory, 'coordinator-peer');
  const options: DockerDesktopRecoveryControllerOptions = {
    original: { routeAuthority: createDockerDesktopRouteAuthority(source.descriptor),
      helper: { protocol: 'agenai.desktop-coordinator.v1', sourceDigest: await readDesktopCoordinatorSourceDigest(),
        executable: { path: originalPath, sha256: sha(await readFile(originalPath)) } } },
    helper: { protocol: 'agenai.desktop-recovery-observer.v1', sourceDigest: `sha256:${recoverySourceDigest}`,
      executable: { path: executablePath, sha256: sha(executable) } },
    desktop: { profile: 'stock-desktop-4.54.0-engine-29.1.2-native-arm64-v1', applicationPath: '/Applications/Docker.app' },
  };
  async function historicalHelper(name: string, sourceDigest: string): Promise<DockerDesktopRecoveryHelper> {
    const path = join(directory, name);
    const body = `#!/bin/sh\n# ${name}\nexec ${quote(process.execPath)} ${quote(scriptPath)} "$@"\n`;
    await writeFile(path, body, { mode: 0o700 });
    return { protocol: options.helper.protocol, sourceDigest, executable: { path, sha256: sha(body) } };
  }
  async function issueHistoricalAttempts(envelope: RecoveryEnvelope, helper: DockerDesktopRecoveryHelper,
    profile: string, count: number, hiddenAcceptance = false): Promise<RecoveryEnvelope> {
    await writeFile(currentPath, encodeRecoveryEnvelope(envelope));
    await writeFile(epochPath, JSON.stringify({ sourceDigest: helper.sourceDigest.slice(7), profileDigest: profile.slice(7), executablePath: helper.executable.path }));
    const prepared = await openPreparedExecutable(helper.executable);
    const peer = new RecoveryNativeOwner(helper.executable.path, envelope.engineKey.slice(7), source.endpoint.slice(7),
      prepared, helper, profile, () => {});
    const publish = async (next: RecoveryEnvelope) => {
      await peer.commitCanonical(rawDigest(encodeRecoveryEnvelope(envelope)), encodeRecoveryEnvelope(next)); envelope = next;
    };
    try {
      await peer.opened;
      await peer.rebindExistingGeneration(envelope.authorityId, envelope.origin.generationId, rawDigest(encodeRecoveryEnvelope(envelope)));
      for (let index = 0; index < count; index++) {
        await publish(transitionRecovery(envelope, { kind: 'refresh_transport', transport: envelope.transport }));
        await publish(transitionRecovery(envelope, { kind: 'clear_release' }));
        await publish(transitionRecovery(envelope, { kind: 'prepare_attempt' }));
        if (envelope.phase.kind !== 'attempt_prepared') assert.fail('Historical fixture did not prepare its next attempt.');
        const preparedRawDigest = rawDigest(encodeRecoveryEnvelope(envelope));
        await peer.bindAttempt({ attempt: envelope.phase.ordinal, expectedCanonicalPayloadDigest: preparedRawDigest,
          previousHistory: envelope.historyHead });
        const armed = await peer.beginObservation();
        await publish(transitionRecovery(envelope, { kind: 'armed', preparedRawDigest, armed: nativeAttemptRefSchema.parse(armed.ref) }));
        let decision: BarrierAcceptanceDecision | undefined;
        if (hiddenAcceptance && index === 0) {
          assert(armed.kind === 'native' && armed.fact.kind === 'armed');
          await writeFile(lifecyclePath, 'stopped');
          const stopped = await peer.observeStopped();
          const stoppedEnvelope = transitionRecovery(envelope, { kind: 'stopped', stopped: nativeAttemptRefSchema.parse(stopped.ref) });
          await publish(stoppedEnvelope);
          await writeFile(lifecyclePath, 'started');
          const classifier = new RestorationClassifier();
          for (const source of ['init', 'console'] as const) {
            const bytes = await peer.readObservedBytes(source); if (bytes.bytes.length) classifier.consume(bytes);
          }
          const finished = await peer.finishFacts();
          assert(finished.kind === 'native' && finished.fact.kind === 'finished');
          assert(stoppedEnvelope.phase.kind === 'stopped');
          const engine = await captureRecoveryEngine(new DockerApi(new DockerEngine(source.endpoint.slice(7)), 1000), originalSnapshot.daemonId);
          const admission = await peer.readReceipt({ kind: 'admission', scope: stoppedEnvelope.phase.ordinal }); assert(admission);
          decision = barrierAcceptanceDecisionSchema.parse({ format: 'agenai.desktop-recovery.sdk-decision.v1', kind: 'barrier_acceptance',
            binding: recoveryDecisionBinding(stoppedEnvelope), attempt: stoppedEnvelope.phase.ordinal, previousHistory: stoppedEnvelope.historyHead, preparedRawDigest,
            native: { admission: admission.ref, armed: stoppedEnvelope.phase.armed, stopped: stoppedEnvelope.phase.stopped, finished: finished.ref },
            transport: { ...stoppedEnvelope.transport, admittedAtSequence: stoppedEnvelope.sequence + 1,
              nativeFactsDigest: recoveryNativeFactsDigest(finished.fact.facts), engineFactsDigest: engine.engineIdentityDigest },
            restoration: classifier.finish(finished.fact, engine, armed.fact) });
          await new RecoveryEvidence(peer, profile).verifyNativeBarrier(stoppedEnvelope, decision);
        }
        const outcome = await peer.abandonObservation();
        if (outcome.ref.scope !== 'attempt' || outcome.ref.slot !== 'outcome') assert.fail('Historical fixture did not issue its outcome.');
        await publish(transitionRecovery(envelope, { kind: 'close_attempt', terminal: { ...outcome.ref, slot: 'outcome' } }));
        await publish(transitionRecovery(envelope, { kind: 'request_release' }));
        if (decision) await peer.publishSdkDecision(decision);
      }
      return envelope;
    } finally { try { await peer.close(); } finally { await rm(epochPath, { force: true }); } }
  }
  async function seedPreviousHelpers(second: boolean, hiddenAcceptance = false) {
    const prepared = createDockerDesktopRecoveryController(options);
    try { await prepared.open({ expectedGeneration: capability.generation }); }
    finally { await prepared.release(); }
    const current = parseRecoveryEnvelope(await readFile(currentPath, 'utf8'));
    const previousHelper = await historicalHelper('previous-installed-observer', PREVIOUS_RECOVERY_SOURCE);
    const originalText = Buffer.from(current.origin.payloadBase64, 'base64').toString('utf8');
    let previous = createRecoveryEnvelope(originalText, { claim: current.origin.claim, archive: current.origin.archive,
      preparation: { ...current.preparation, recoveryHelper: previousHelper }, transport: current.transport });
    previous = await issueHistoricalAttempts(previous, previousHelper, PREVIOUS_RECOVERY_PROFILE, second ? 2 : 1);
    if (!second) return { helper: previousHelper, envelope: previous, text: encodeRecoveryEnvelope(previous) };
    const successor = await historicalHelper('first-successor-observer', FIRST_SUCCESSOR_SOURCE);
    previous = planHelperReplacement(previous, previousHelper, successor, FIRST_SUCCESSOR_PROFILE);
    previous = await issueHistoricalAttempts(previous, successor, FIRST_SUCCESSOR_PROFILE, 2, hiddenAcceptance);
    return { helper: successor, envelope: previous, text: encodeRecoveryEnvelope(previous) };
  }
  async function events(): Promise<PeerEvent[]> {
    try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return []; throw cause; }
  }
  return { source, options, configuration: memberConfiguration, record: parseSandboxRecoveryRecord(member.checkpoint.record),
    returnedContainerId,
    generation: capability.generation, createOwner: () => createDockerDesktopRecoveryController(options), events,
    setOffline(value: boolean) { offline = value; }, occupy(name?: string) { occupied = name; },
    release: () => writeFile(releasePath, ''), fault: (value: RecoveryControllerFault) => writeFile(faultPath, value),
    simulateStop: () => writeFile(lifecyclePath, 'stopped'), simulateStart: () => writeFile(lifecyclePath, 'started'),
    seedPreviousHelper: () => seedPreviousHelpers(false),
    seedTwoPreviousHelpers: (hiddenAcceptance = false) => seedPreviousHelpers(true, hiddenAcceptance),
    async queueOriginalDelete() {
      const current = parseRecoveryEnvelope(await readFile(currentPath, 'utf8'));
      const generation = current.projection.snapshot.generation; assert(generation.kind === 'dirty' && generation.members[0]);
      const queued = planCleanupTransition(current, { kind: 'queue', memberId: generation.members[0].memberId, role: 'compute', action: 'delete' });
      await writeFile(currentPath, encodeRecoveryEnvelope(queued)); return encodeRecoveryEnvelope(queued);
    },
    async kill() {
      const pid = (await events()).findLast((event) => event.command === 'OPEN')?.pid;
      if (pid === undefined) throw new Error('Missing fixture recovery process');
      process.kill(pid, 'SIGKILL');
      for (let attempt = 0; attempt < 1000; attempt++) {
        try { process.kill(pid, 0); }
        catch (cause) { if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH') return; throw cause; }
        await delay(5);
      }
      throw new Error('Recovery fixture process did not join');
    },
    async waitFor(command: string) {
      for (let attempt = 0; attempt < 1000; attempt++) { if ((await events()).some((event) => event.command === command)) return; await delay(5); }
      throw new Error(`Missing recovery fixture command ${command}`);
    },
    async currentText() { return readFile(currentPath, 'utf8'); },
    async close() { await writeFile(releasePath, ''); await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
  } catch (cause) {
    releaseStartup?.(); await source.releaseCommit(); await source.terminateHolder().catch(() => {});
    await source.close(); throw cause;
  }
}
