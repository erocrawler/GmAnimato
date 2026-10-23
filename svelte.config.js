import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { preprocessMeltUI, sequence } from '@melt-ui/pp';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: sequence([vitePreprocess(), preprocessMeltUI()]),

	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(),
		// The origin check is re-implemented in src/hooks.server.ts (src/lib/csrf.ts)
		// so that personal-access-token requests can be exempted; SvelteKit's own
		// check runs before hooks and cannot be bypassed from there. ['*'] switches the
		// built-in check off (checkOrigin:false is deprecated).
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;
