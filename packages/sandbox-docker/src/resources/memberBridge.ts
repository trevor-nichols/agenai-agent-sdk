// ------------------------------------------------------------------------------------------------
//                memberBridge.ts - Original coordinator membership and operation-scope ownership
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { SandboxPolicy } from '@agen-ai/sandbox';
import type { SandboxDriverFiles, SandboxDriverReady, SandboxDriverStartOptions } from '@agen-ai/sandbox/backend';
import type { DesktopCoordinatorMember, DesktopCoordinatorMemberOwner } from '../network/desktop/coordinator/member.js';

type ResourceOwner = Omit<DesktopCoordinatorMemberOwner, 'policy' | 'persist' | 'enrolled'>;
interface Admission {
  closed(): boolean;
  assertOpen(signal?: AbortSignal): void;
}
interface WorkScope { readonly token: string; readonly entered: Promise<void> }
type WorkScopeName = Parameters<DesktopCoordinatorMember['workEnter']>[0];

export class DockerMemberBridge {
  private current: DesktopCoordinatorMember | undefined;
  private enrollment: Promise<DesktopCoordinatorMember> | undefined;
  private readonly scopes = new Map<WorkScopeName, WorkScope>();
  private readonly writers = new Set<Promise<unknown>>();
  private readonly exports = new Set<Promise<unknown>>();

  constructor(private readonly owner: ResourceOwner, private readonly admission: Admission) {}

  get member(): DesktopCoordinatorMember | undefined { return this.current; }

  async start(policy: SandboxPolicy, options: SandboxDriverStartOptions, acquire: () => Promise<SandboxDriverReady>): Promise<SandboxDriverReady> {
    if (this.owner.config.coordinator) {
      this.enrollment = this.owner.config.coordinator.enroll({ ...this.owner, policy,
        persist: (record) => options.checkpoint(record),
        enrolled: (member) => { this.current = member; if (this.admission.closed()) member.closeAdmission(); },
      }, options.signal);
      this.current = await this.enrollment;
      this.admission.assertOpen(options.signal);
      await this.enterScope('initialization');
    }
    try { return await acquire(); }
    finally {
      await this.joinScope('initialization');
    }
  }

  async settleEnrollment(): Promise<void> { await this.enrollment?.catch(() => {}); }

  enterPrimary(): Promise<void> | undefined {
    return this.enterScope('primary');
  }

  async write<Value>(perform: () => Promise<Value>): Promise<Value> {
    if (!this.current) return perform();
    this.admission.assertOpen();
    const entered = this.enterScope('writers');
    const actual = Promise.resolve().then(async () => {
      await entered;
      this.admission.assertOpen();
      return perform();
    });
    this.writers.add(actual);
    try { return await actual; }
    finally { this.writers.delete(actual); }
  }

  files(files: SandboxDriverFiles): SandboxDriverFiles {
    if (!this.current) return files;
    const read = {
      stat: (...args: Parameters<typeof files.stat>) => this.write(() => files.stat(...args)),
      list: (...args: Parameters<typeof files.list>) => this.write(() => files.list(...args)),
      readFile: (...args: Parameters<typeof files.readFile>) => this.write(() => files.readFile(...args)),
    };
    return files.kind === 'read_only' ? Object.freeze({ kind: 'read_only', ...read })
      : Object.freeze({ kind: 'read_write', ...read,
        writeFile: (...args: Parameters<typeof files.writeFile>) => this.write(() => files.writeFile(...args)) });
  }

  async export<Value>(perform: () => Promise<Value>): Promise<Value> {
    if (!this.current) return perform();
    const entered = this.enterScope('export');
    const actual = Promise.resolve().then(async () => { await entered; return perform(); });
    this.exports.add(actual);
    try { return await actual; }
    finally { this.exports.delete(actual); }
  }

  async joinProducers(): Promise<readonly unknown[]> {
    await Promise.allSettled([...this.writers]);
    const failures: unknown[] = [];
    for (const scope of ['initialization', 'primary', 'writers'] as const) {
      try { await this.joinScope(scope); }
      catch (error) { failures.push(error); }
    }
    return failures;
  }

  async joinExports(): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    if (!this.current) return failures;
    for (const result of await Promise.allSettled([...this.exports])) if (result.status === 'rejected') failures.push(result.reason);
    try { await this.joinScope('export'); }
    catch (error) { failures.push(error); }
    return failures;
  }

  private enterScope(scope: WorkScopeName): Promise<void> | undefined {
    if (!this.current) return undefined;
    let owned = this.scopes.get(scope);
    if (!owned) {
      const token = randomUUID();
      owned = { token, entered: this.current.workEnter(scope, token) };
      this.scopes.set(scope, owned);
    }
    return owned.entered;
  }

  private async joinScope(scope: WorkScopeName): Promise<void> {
    const owned = this.scopes.get(scope);
    if (!owned || !this.current) return;
    // An acknowledgement failure can still leave a durable work_enter; the canonical writer resolves it before joining.
    await owned.entered.catch(() => {});
    await this.current.workJoin(scope, owned.token);
    this.scopes.delete(scope);
  }
}
