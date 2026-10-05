/** The build a replay or multiplayer peer was made with (the git commit, set by vite.config.ts's
 * `define`; 'dev' where nothing defines it). Replays from another build may not reproduce. */
declare const __BUILD_VERSION__: string | undefined;
export const BUILD_VERSION: string = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
