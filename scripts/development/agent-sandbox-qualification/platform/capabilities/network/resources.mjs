import assert from 'node:assert/strict';

export function identified(record, role) {
  const resource = record.resources.find((entry) => entry.role === role);
  assert(resource?.identity.kind === 'identified', `Original owner has no identified ${role}.`);
  return resource;
}
export function resourcePath(resource) {
  const reference = encodeURIComponent(resource.identity.kind === 'identified' ? resource.identity.id : resource.name);
  if (resource.role === 'network') return `/networks/${reference}`;
  if (['storage', 'egress_socket'].includes(resource.role)) return `/volumes/${reference}`;
  assert(['compute', 'filesystem', 'export', 'egress_broker', 'egress_relay', 'route_observer'].includes(resource.role));
  return `/containers/${reference}/json`;
}
export async function census(engine, record, checkpoint, absent = false) {
  const observations = [];
  for (const resource of record.resources) {
    const response = await engine.request('GET', resourcePath(resource), undefined, { allowed: absent ? [404] : [200, 404] });
    observations.push({ checkpoint, role: resource.role, name: resource.name, identity: resource.identity,
      status: response.status, ...(response.status === 200 ? { actualId: response.data.Id ?? response.data.Name,
        state: response.data.State, image: response.data.Image, labels: response.data.Config?.Labels ?? response.data.Labels,
        network: response.data.NetworkSettings, mounts: response.data.Mounts } : {}) });
  }
  return observations;
}
