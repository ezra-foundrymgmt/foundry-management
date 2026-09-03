/**
 * `server-only` is resolved by Next's bundler alias, not by node resolution, so
 * importing a server module under vitest fails without a stub. Aliasing it to
 * this empty module lets us unit-test server-side logic (the environment
 * contract, authorization helpers) while the real guard still applies in builds.
 */
export {};
