// ------------------------------------------------------------------------------------------------
//                responses.ts - Shared bounded Docker container-create response boundary
// ------------------------------------------------------------------------------------------------

import { z } from 'zod/v4';
import { MAX_DATASET_ATTACHMENTS } from '../datasets/configuration.js';

export const containerCreatedSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u),
  Warnings: z.array(z.string()).max(MAX_DATASET_ATTACHMENTS).nullable().optional() });
