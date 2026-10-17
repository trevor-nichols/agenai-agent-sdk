import { AcpRpcHandlerError, type AcpJsonObject, type AcpJsonValue, type AcpReverseRequestContext } from '@agen-ai/acp-transport';

import type { AcpInitializedConnection } from '../../connection/contracts.js';
import { nativeObject } from '../native.js';
import { prepareAcpForm, validateAcpFormSchema, type PreparedAcpForm } from './forms.js';

/** Native-only forms require explicit host UI authority; canonical choices always use the runtime request port. */
export function prepareAcpSessionElicitation(input: {
  readonly context: AcpReverseRequestContext;
  readonly params: AcpJsonObject;
  readonly lifetime: AbortSignal;
  readonly host: AcpInitializedConnection['hostElicitation'];
}): Readonly<{ form?: PreparedAcpForm; host?: (observeCallback: (work: Promise<void>) => void) => Promise<AcpJsonValue> }> {
  try {
    if (input.params.mode === 'form') {
      validateAcpFormSchema(nativeObject(input.params.requestedSchema, 'requested form schema'));
      try { return { form: prepareAcpForm(input.params) }; }
      catch (error) { if (!input.host) throw error; }
    } else if (input.params.mode !== 'url') throw new Error('Unsupported ACP elicitation mode.');
    const invoke = input.host;
    if (!invoke) throw new Error('This ACP elicitation requires an explicitly configured host UI.');
    const signal = AbortSignal.any([input.context.signal, input.lifetime]);
    return { host: (observeCallback) => invoke({ ...input.context, signal }, observeCallback) };
  } catch (error) {
    throw new AcpRpcHandlerError(-32602, error instanceof Error ? error.message : 'Unsupported ACP form.');
  }
}
