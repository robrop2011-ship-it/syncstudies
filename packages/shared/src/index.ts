/**
 * IMPORT CONVENTION: relative imports in this package are EXTENSIONLESS.
 *
 * TypeScript's `moduleResolution: "Bundler"` expects that, and it is the only
 * form all four of our toolchains agree on. Writing `./video.js` (the Node-ESM
 * style) breaks Turbopack, which has no `extensionAlias` escape hatch — and it
 * breaks it at DEV time only, while `tsc --noEmit` still passes, so the failure
 * shows up as a blank page rather than a compile error.
 */
export * from './constants';
export * from './ids';
export * from './video';
export * from './player';
export * from './permissions';
export * from './events';
export * as Schemas from './schemas';
