export {};

// Secrets set via `wrangler secret put` (prod) or `.dev.vars` (local).
// wrangler types only generates bindings declared in wrangler.jsonc, so
// these are declared by hand and merged into the global Env interface.
declare global {
	interface Env {
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		COOKIE_ENCRYPTION_KEY: string;
	}

	namespace Cloudflare {
		interface Env {
			GITHUB_CLIENT_ID: string;
			GITHUB_CLIENT_SECRET: string;
			COOKIE_ENCRYPTION_KEY: string;
		}
	}
}
