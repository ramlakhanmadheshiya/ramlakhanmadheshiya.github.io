// @ts-check
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://theramlakhan.com',
	integrations: [mdx(), sitemap()],
	redirects: {
		'/resume': '/cv/',
	},
	markdown: {
		shikiConfig: {
			themes: { light: 'github-light', dark: 'github-dark' },
		},
	},
	build: { inlineStylesheets: 'auto' },
});
