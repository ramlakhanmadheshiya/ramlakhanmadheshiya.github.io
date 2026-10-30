// Pages published by other tools (game pages, privacy policies, Bill Studio builds, ...)
// live as plain folders in the repo root. Copy them next to the built site so their
// URLs keep working. Add a name here when a new top-level folder should be published.
import { cp, access } from 'node:fs/promises';

const STATIC = [
	'404.html',
	'CNAME',
	'app-ads.txt',
	'apps',
	'browsers_theme',
	'games',
	'one-clean-shot',
	'projects',
	'test',
];

for (const name of STATIC) {
	try {
		await access(name);
	} catch {
		continue;
	}
	await cp(name, `dist/${name}`, { recursive: true });
	console.log(`copied ${name}`);
}
