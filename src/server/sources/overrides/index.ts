import type { SourceOverride } from './types.js';

/**
 * Register hand-written overrides here. Keeping this an explicit list (rather
 * than a directory scan) means the compiler checks every entry and the bundle
 * stays statically analysable.
 *
 *   import { exampleOverride } from './example.js';
 *   export const overrides: SourceOverride[] = [exampleOverride];
 */
export const overrides: SourceOverride[] = [];

export type { SourceOverride };
