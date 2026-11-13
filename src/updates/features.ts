import type { Config } from '../config.js';

export const POSTLAUNCH_IDS = ['refunds', 'prices', 'receipt-links', 'leash-presets', 'runway', 'accounting',
  'fossils', 'agent-economics', 'copy-examples', 'host-calculator', 'status-changelog'] as const;
export type PostlaunchFeature = typeof POSTLAUNCH_IDS[number];
export const implementedFeatures: readonly PostlaunchFeature[] = ['refunds', 'prices', 'receipt-links', 'leash-presets'];
export function featureEnabled(config: Pick<Config, 'POSTLAUNCH_FEATURES'>, feature: PostlaunchFeature): boolean {
  return implementedFeatures.includes(feature) && config.POSTLAUNCH_FEATURES.includes(feature);
}
export function publicFeatures(config: Pick<Config, 'POSTLAUNCH_FEATURES'>): readonly PostlaunchFeature[] {
  return implementedFeatures.filter(feature => featureEnabled(config, feature));
}
