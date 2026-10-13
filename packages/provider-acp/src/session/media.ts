import type { AcpStandardContentBlock } from '@agen-ai/acp-transport';
import type { AgentCapabilities, AgentTurnInputPart } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from './errors.js';

/** ACP image URIs are supplemental; the native image content always requires inline bytes. */
export function prepareAcpPrompt(parts: readonly AgentTurnInputPart[], capabilities: AgentCapabilities): AcpStandardContentBlock[] {
  let imageCount = 0;
  let totalBytes = 0;
  return parts.map((part): AcpStandardContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type !== 'image' || capabilities.input.images.kind !== 'supported'
      || part.source.type !== 'base64') {
      throw new AcpProviderSessionError('acp_input_unsupported', 'ACP accepts text and explicitly supported inline base64 images.');
    }
    const source = part.source;
    const limits = capabilities.input.images;
    imageCount += 1;
    totalBytes += source.byteSize;
    if (!limits.sourceKinds.includes(source.type) || !limits.mediaTypes.includes(source.mediaType)
      || source.byteSize > limits.maxBytesPerImage || totalBytes > limits.maxTotalBytes
      || imageCount > limits.maxImages || source.widthPixels > limits.maxWidthPixels
      || source.heightPixels > limits.maxHeightPixels
      || source.widthPixels * source.heightPixels > limits.maxPixelsPerImage
      || Buffer.from(source.data, 'base64').byteLength !== source.byteSize) {
      throw new AcpProviderSessionError('acp_image_limit_exceeded', 'The inline image exceeds the declared ACP image capability.');
    }
    return { type: 'image', data: source.data, mimeType: source.mediaType };
  });
}
