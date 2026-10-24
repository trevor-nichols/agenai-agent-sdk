// ------------------------------------------------------------------------------------------------
//                evidence.ts - Bounded cleanup claim checking - Ordered independent exact-resource proof
// ------------------------------------------------------------------------------------------------

// Cleanup claims are checked against ordered, exact-resource observations. JSON is evidence data,
// not authentication of the observer or proof that a controller told the truth.

export type EvidenceResourceRole = 'compute' | 'storage' | 'export' | 'network';
export interface EvidenceResource { readonly role: EvidenceResourceRole; readonly id: string }
export type CleanupEvidenceEvent =
  | Readonly<{ sequence: number; kind: 'sdk-close'; result: 'fulfilled' | 'rejected' }>
  | Readonly<{ sequence: number; kind: 'observation'; source: 'independent-engine'; role: EvidenceResourceRole; id: string; httpStatus: number }>
  | Readonly<{ sequence: number; kind: 'external-cleanup'; role: EvidenceResourceRole; id: string }>;
export interface CleanupEvidenceRow {
  readonly label: string;
  readonly expected: readonly EvidenceResource[];
  readonly events: readonly CleanupEvidenceEvent[];
}
export interface CleanupEvidenceReport {
  readonly format: 'agenai.sandbox-cleanup-evidence.v1';
  readonly rows: readonly CleanupEvidenceRow[];
}
export type CleanupEvidenceVerdict = Readonly<{ kind: 'accepted'; rows: number }> | Readonly<{ kind: 'rejected'; reason: string }>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function role(value: unknown): value is EvidenceResourceRole {
  return value === 'compute' || value === 'storage' || value === 'export' || value === 'network';
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/u.test(value);
}

function boundedData(input: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number; leaving?: boolean }> = [{ value: input, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) return false;
    const { value, depth } = entry;
    if (entry.leaving) { if (value !== null && typeof value === 'object') ancestors.delete(value); continue; }
    if (++nodes > 16_384 || depth > 8) return false;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') { if (value.length > 1024) return false; continue; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) return false; continue; }
    if (!Array.isArray(value) && !object(value)) return false;
    if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (ancestors.has(value) || Object.getOwnPropertySymbols(value).length) return false;
    ancestors.add(value);
    pending.push({ value, depth, leaving: true });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(descriptors).length > 1024) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!('value' in descriptor) || key.length > 128) return false;
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  return Buffer.byteLength(JSON.stringify(input), 'utf8') <= 256 * 1024;
}

function evaluateCleanupEvidence(input: unknown): CleanupEvidenceVerdict {
  const reject = (reason: string): CleanupEvidenceVerdict => ({ kind: 'rejected', reason });
  if (!boundedData(input)) return reject('Evidence exceeds bounded plain-data limits.');
  if (!object(input) || input.format !== 'agenai.sandbox-cleanup-evidence.v1'
    || !Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 128) return reject('Evidence needs one through 128 cleanup rows.');
  const labels = new Set<string>();
  for (const row of input.rows) {
    if (!object(row) || !text(row.label, 128) || labels.has(row.label)) return reject('Cleanup rows need unique bounded labels.');
    labels.add(row.label);
    const prefix = `${row.label}: `;
    if (!Array.isArray(row.expected) || row.expected.length < 1 || row.expected.length > 4) return reject(`${prefix}expected exact resources are missing or excessive.`);
    const expected = new Map<string, string>();
    for (const resource of row.expected) {
      if (!object(resource) || !role(resource.role) || !text(resource.id, 256) || expected.has(resource.role)) return reject(`${prefix}expected resources have an invalid or duplicate identity.`);
      expected.set(resource.role, resource.id);
    }
    if (!Array.isArray(row.events) || row.events.length < 2 || row.events.length > 64) return reject(`${prefix}ordered close and observation events are required.`);
    let closed = false;
    const absent = new Set<string>();
    for (const [index, event] of row.events.entries()) {
      if (!object(event) || event.sequence !== index + 1) return reject(`${prefix}event ordering is invalid.`);
      if (event.kind === 'sdk-close') {
        if (closed || event.result !== 'fulfilled') return reject(`${prefix}SDK close did not uniquely fulfill.`);
        closed = true;
        continue;
      }
      if (!role(event.role) || !text(event.id, 256) || expected.get(event.role) !== event.id) return reject(`${prefix}event resource identity does not match the expected resource.`);
      if (event.kind === 'observation') {
        if (!closed) return reject(`${prefix}resource observation preceded SDK close.`);
        if (event.source !== 'independent-engine' || event.httpStatus !== 404) return reject(`${prefix}independent observation did not prove resource absence.`);
        absent.add(event.role);
      } else if (event.kind === 'external-cleanup') {
        if (!closed || absent.size !== expected.size) return reject(`${prefix}external cleanup preceded complete SDK-close absence proof.`);
      } else return reject(`${prefix}unknown cleanup event.`);
    }
    if (!closed || absent.size !== expected.size) return reject(`${prefix}exact resource observation is missing after SDK close.`);
  }
  return { kind: 'accepted', rows: input.rows.length };
}

export function checkCleanupEvidence(input: unknown): CleanupEvidenceVerdict {
  try { return evaluateCleanupEvidence(input); }
  catch { return { kind: 'rejected', reason: 'Evidence is not bounded plain data.' }; }
}
