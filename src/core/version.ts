/** Set by the release pipeline (Dockerfile build argument); `dev` for local runs. */
export const VERSION = process.env.SWITCHBOARD_VERSION ?? 'dev';
