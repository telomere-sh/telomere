import { z } from 'zod';
import { largeCystRegistryDescriptorSchema, largeCystRegistryPlanSchema } from './large-registry.js';
import { cystRegistryBindingSchema, cystRegistryPinsSchema, cystRegistryStateSchema } from './registry-types.js';
import { cystIdSchema } from './types.js';

export type LargeCystRegistryPlan = z.infer<typeof largeCystRegistryPlanSchema>;

/** The manifest is parsed separately with parseLargeCystManifest so its
 * immutable descriptor can be recomputed before a current locator is trusted.
 */
export const largeCystCurrentCheckpointSchema = z.object({
  checkpointId: cystIdSchema,
  checkpoint: largeCystRegistryDescriptorSchema,
  binding: cystRegistryBindingSchema,
  current: cystRegistryStateSchema,
  pins: cystRegistryPinsSchema,
  manifest: z.unknown(),
}).strict();
