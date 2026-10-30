export type Link = { label: string; href: string };

export type Project = {
	name: string;
	year: string;
	blurb: string;
	tags: string[];
	links: Link[];
	status?: string;
};

export type PullRequest = {
	repo: string;
	number: number;
	title: string;
	state: 'merged' | 'open';
	url: string;
};

const gh = (repo: string) => ({ label: 'GitHub', href: `https://github.com/ramlakhanmadheshiya/${repo}` });
const hub = { label: 'Games', href: '/BrainnovaStudio/games/' };

/** Pull requests, newest first. State as of 30 Oct 2026. */
export const pullRequests: PullRequest[] = [
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4899, state: 'open', title: "Initialize the DDE history's stiff default-solver sub-caches instead of assigning the solver's", url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4899' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4892, state: 'open', title: 'Keep constrained and fpsolve when MethodOfSteps rebuilds an AutoSwitch algorithm', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4892' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4879, state: 'open', title: 'Call perform_step! without repeat_step in the DDE fixed-point recompute', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4879' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4874, state: 'open', title: 'Build the fixed-point solver for constrained MethodOfSteps', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4874' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4872, state: 'open', title: 'Build the discontinuity bracket in the unitless step-fraction type', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4872' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4849, state: 'merged', title: 'Allow zero constant lags and reject wrong-sign ones in DDE init', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4849' },
	{ repo: 'SciML/OrdinaryDiffEq.jl', number: 4834, state: 'merged', title: 'Define default_linear_interpolation with the problem first', url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4834' },
	{ repo: 'ibis-project/ibis', number: 10090, state: 'merged', title: 'docs(dropdowns): make dropdowns scrollable and easier to see in navigation bar', url: 'https://github.com/ibis-project/ibis/pull/10090' },
];

export const issues: Link[] = [
	{ label: 'OrdinaryDiffEq.jl #4895', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/issues/4895' },
	{ label: 'OrdinaryDiffEq.jl #4891', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/issues/4891' },
	{ label: 'OrdinaryDiffEq.jl #4876', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/issues/4876' },
	{ label: 'OrdinaryDiffEq.jl #4875', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/issues/4875' },
	{ label: 'NonlinearSolve.jl #1372', href: 'https://github.com/SciML/NonlinearSolve.jl/issues/1372' },
];

export const openSource: Project[] = [
	{
		name: 'SciML / OrdinaryDiffEq.jl',
		year: '2026',
		blurb: 'Julia solvers for ODEs, DDEs and DAEs. I work on the delay-equation side (DelayDiffEq\'s MethodOfSteps): lag handling, constrained mode, composite algorithms and unit-carrying time types.',
		tags: ['Julia', 'DDE', 'Numerical solvers'],
		status: '2 merged · 5 open',
		links: [{ label: 'Repository', href: 'https://github.com/SciML/OrdinaryDiffEq.jl' }],
	},
	{
		name: 'ibis-project / ibis',
		year: '2024',
		blurb: 'The portable Python dataframe library. Made the documentation\'s navigation dropdowns scrollable.',
		tags: ['Python', 'Docs'],
		status: '1 merged',
		links: [{ label: 'Pull request', href: 'https://github.com/ibis-project/ibis/pull/10090' }],
	},
];

export const games: Project[] = [
	{ name: 'Single Shot', year: '2026', status: 'Google Play closed testing', blurb: 'A quiet ricochet puzzle: bank one orb off the walls to pop every target. 360 rooms in 9 chapters, each room checked by a solver.', tags: ['Godot 4', 'Android', 'Web'], links: [gh('single-shot'), hub] },
	{ name: 'Ringburst', year: '2026', blurb: 'A one-touch hold-and-release arcade. Grow a ring, burst it, land PERFECTs. 320 levels across 8 worlds with a boss each.', tags: ['Godot 4', 'Arcade'], links: [gh('ringburst'), hub] },
	{ name: 'Word Glow', year: '2026', blurb: 'Trace hidden themed words to light up a grid. Every level has exactly one valid answer, enforced by a level checker.', tags: ['Godot 4', 'Word puzzle'], links: [gh('word-glow'), hub] },
	{ name: 'Snug Fit', year: '2026', blurb: 'Fill a silhouette with pieces. 210 levels in 7 chapters, each built from its answer and verified by a solver.', tags: ['Godot 4', 'Puzzle'], links: [gh('snug-fit'), hub] },
	{ name: 'Mirrorlock', year: '2026', blurb: 'Every piece has a mirrored twin; tap one and both slide away, unless something is in the way. 360 levels, 9 chapters.', tags: ['Godot 4', 'Puzzle'], links: [gh('mirrorlock'), hub] },
	{ name: 'Corral', year: '2026', blurb: 'An endless enclosure puzzle. Close off a pen to score its area squared. Includes a daily board and 120 bot-verified challenges.', tags: ['Godot 4', 'Puzzle'], links: [gh('corral'), hub] },
];

export const webApps: Project[] = [
	{ name: 'Bill Studio', year: '2026', blurb: 'Free, offline, multi-country billing. GST, VAT and sales-tax rules for 50+ countries, a drag-and-drop bill designer, ledgers, reports, payment QR codes and encrypted backups. Installable PWA, no server.', tags: ['JavaScript', 'PWA', 'IndexedDB'], links: [{ label: 'Live', href: '/projects/bill-studio/' }, gh('bill-studio')] },
	{ name: 'Brainnova Studio', year: '2026', blurb: 'The games site: one JSON file drives every card, page and button, built with a small Python generator and published through GitHub Actions.', tags: ['Python', 'GitHub Actions'], links: [{ label: 'Live', href: '/BrainnovaStudio/games/' }, gh('BrainnovaStudio')] },
];

export const security: Project[] = [
	{ name: 'Group Policy Object Manager', year: '2024', status: 'Smart India Hackathon finalist', blurb: 'A Windows app that generates and manages customised GPOs aligned with CIS security benchmarks, built for the NTRO problem statement.', tags: ['C#', '.NET', 'WPF'], links: [gh('Project-Techolics_')] },
	{ name: 'NTRO security tool', year: '2025', blurb: 'Built during an onsite internship at the National Technical Research Organisation to improve internal compliance. Details are confidential.', tags: ['Security', 'Compliance'], links: [] },
];

export const research: Project[] = [
	{ name: 'Windows CVE Analysis: Vulnerabilities, Exploits, and Defenses', year: '2025', status: 'Manuscript', blurb: 'First-author manuscript with Santosh Saha.', tags: ['Security', 'Windows'], links: [{ label: 'Paper', href: 'https://github.com/ramlakhanmadheshiya/Research-Papers/tree/main/2025-Windows_CVE_Analysis' }] },
];
