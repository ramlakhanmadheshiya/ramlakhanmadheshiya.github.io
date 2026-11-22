export type Link = { label: string; href: string };

export type Project = {
	name: string;
	year: string;
	blurb: string;
	tags: string[];
	links: Link[];
	status?: string;
	featured?: boolean;
};

export type PullRequest = {
	repo: string;
	number: number;
	title: string;
	state: 'merged';
	url: string;
	description?: string;
};

const gh = (repo: string) => ({ label: 'Source', href: `https://github.com/ramlakhanmadheshiya/${repo}` });
const hub = { label: 'Games Hub', href: '/BrainnovaStudio/games/' };

/** Merged upstream pull requests, newest first. */
export const pullRequests: PullRequest[] = [
	{
		repo: 'SciML/OrdinaryDiffEq.jl',
		number: 4849,
		state: 'merged',
		title: 'Allow zero constant lags and reject wrong-sign ones in DDE init',
		url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4849',
		description: 'Fixed maximum step size bounds in delay differential equations by skipping zero lags and validating lag directions against tspan orientation with Unitful compatibility.'
	},
	{
		repo: 'SciML/OrdinaryDiffEq.jl',
		number: 4834,
		state: 'merged',
		title: 'Define default_linear_interpolation with the problem first',
		url: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4834',
		description: 'Restored solver-specific interpolation opt-outs by fixing method dispatch order, ensuring DAE and sensitivity workflows retain required dense output.'
	},
	{
		repo: 'ibis-project/ibis',
		number: 10090,
		state: 'merged',
		title: 'docs(dropdowns): make dropdowns scrollable and easier to see in navigation bar',
		url: 'https://github.com/ibis-project/ibis/pull/10090',
		description: 'Enhanced documentation accessibility and navigation across deep API submenus by introducing responsive scrollable containers.'
	},
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
		blurb: 'Production numerical solvers for ODEs, DDEs and DAEs in Julia. Authored merged fixes to DelayDiffEq\'s MethodOfSteps: lag initialization, sign validation, and interpolation method dispatch.',
		tags: ['Julia', 'Numerical Solvers', 'SciML', 'DDE'],
		status: 'Merged Upstream',
		featured: true,
		links: [
			{ label: 'Repository', href: 'https://github.com/SciML/OrdinaryDiffEq.jl' },
			{ label: 'PR #4849', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4849' },
			{ label: 'PR #4834', href: 'https://github.com/SciML/OrdinaryDiffEq.jl/pull/4834' },
		],
	},
	{
		name: 'ibis-project / ibis',
		year: '2024',
		blurb: 'Portable Python dataframe engine for analytics across 20+ SQL backends. Merged UX contribution making complex multi-level documentation navigation menus scrollable and responsive.',
		tags: ['Python', 'Dataframe', 'Documentation', 'UX'],
		status: 'Merged Upstream',
		featured: false,
		links: [
			{ label: 'Pull Request #10090', href: 'https://github.com/ibis-project/ibis/pull/10090' }
		],
	},
];

export const webApps: Project[] = [
	{
		name: 'Bill Studio',
		year: '2026',
		blurb: 'Free, offline-first invoice & billing web application. Supports tax systems for 50+ countries (GST, VAT, sales tax), drag-and-drop bill designer, ledgers, reports, payment QR codes, and client-side AES encrypted backups. Zero server requirement.',
		tags: ['JavaScript', 'PWA', 'IndexedDB', 'Offline-First'],
		status: 'Live Web App',
		featured: true,
		links: [
			{ label: 'Launch App', href: '/projects/bill-studio/' },
			gh('bill-studio')
		]
	},
	{
		name: 'ghtrack',
		year: '2026',
		blurb: 'Ultra-fast GitHub lifetime contribution & activity analyzer. Computes exact totals for PRs, issues, reviews, and comments in ~2 seconds for accounts with 48,000+ items without authentication or rate-limit tokens. IndexedDB client caching and conversation preview.',
		tags: ['JavaScript', 'GitHub API', 'IndexedDB', 'Performance'],
		status: 'Live Web App',
		featured: true,
		links: [
			{ label: 'Launch App', href: '/ghtrack/' },
			gh('ghtrack')
		]
	},
	{
		name: 'ghpr',
		year: '2026',
		blurb: 'GitHub PR triage and health dashboard for open-source maintainers. Tracks 14 health and priority signals — merge conflicts, CI checks, line churn, test ratio, and author history — to categorize pull requests into actionable queues.',
		tags: ['JavaScript', 'GitHub API', 'Developer Tooling'],
		status: 'Live Web App',
		featured: true,
		links: [
			{ label: 'Launch App', href: '/ghpr/' },
			gh('ghpr')
		]
	},
	{
		name: 'Brainnova Studio',
		year: '2026',
		blurb: 'Independent games showcase and web platform. Driven by declarative JSON schemas with an automated Python static site generator and deployed via GitHub Actions.',
		tags: ['Python', 'Static Site', 'GitHub Actions'],
		status: 'Live Hub',
		featured: false,
		links: [
			{ label: 'Explore Hub', href: '/BrainnovaStudio/games/' },
			gh('BrainnovaStudio')
		]
	},
];

export const security: Project[] = [
	{
		name: 'GPO Compliance Manager',
		year: '2024',
		status: 'SIH 2024 Finalist',
		blurb: 'Windows system security tool that generates and enforces customized Group Policy Objects aligned with CIS benchmarks. Developed for the NTRO challenge in the Smart India Hackathon.',
		tags: ['C#', '.NET', 'WPF', 'CIS Benchmarks', 'Security'],
		featured: true,
		links: [gh('Project-Techolics_')]
	},
	{
		name: 'NTRO Security Compliance Suite',
		year: '2025',
		status: 'Onsite Internship',
		blurb: 'Built onsite during a software engineering internship at the National Technical Research Organisation (NTRO) to automate security compliance verification and internal audit flows. Architecture details protected under NDA.',
		tags: ['Security', 'Compliance', 'Audit Automation'],
		featured: false,
		links: [{ label: 'CV Details', href: '/cv/' }]
	},
];

export const research: Project[] = [
	{
		name: 'Windows CVE Analysis: Vulnerabilities, Exploits, and Defenses',
		year: '2025',
		status: 'Research Manuscript',
		blurb: 'First-author in-depth analytical study investigating recurring vulnerability patterns, exploitation vectors, and kernel/userland mitigation techniques in modern Windows systems.',
		tags: ['Security Research', 'Windows CVE', 'Vulnerability Analysis'],
		featured: false,
		links: [{ label: 'Read Manuscript', href: 'https://github.com/ramlakhanmadheshiya/Research-Papers/tree/main/2025-Windows_CVE_Analysis' }]
	},
];

export const games: Project[] = [
	{
		name: 'Single Shot',
		year: '2026',
		status: 'Google Play Testing',
		blurb: 'A quiet ricochet puzzle: bank one orb off walls to pop every target. 360 rooms across 9 chapters, with every room generated and verified by an automated solver.',
		tags: ['Godot 4', 'Android', 'Solver Verified'],
		featured: true,
		links: [gh('single-shot'), hub]
	},
	{
		name: 'Ringburst',
		year: '2026',
		blurb: 'One-touch hold-and-release arcade game. Expand rings, burst them on beat, and land perfect timings across 320 levels with world bosses.',
		tags: ['Godot 4', 'Arcade', 'Mobile'],
		featured: false,
		links: [gh('ringburst'), hub]
	},
	{
		name: 'Word Glow',
		year: '2026',
		blurb: 'Trace hidden themed words to illuminate grids. Every level is algorithmically checked to guarantee exactly one valid solution.',
		tags: ['Godot 4', 'Word Puzzle', 'Automated Checker'],
		featured: false,
		links: [gh('word-glow'), hub]
	},
	{
		name: 'Snug Fit',
		year: '2026',
		blurb: 'Geometric silhouette packing puzzle. 210 handcrafted levels in 7 chapters, verified with automated puzzle solvers.',
		tags: ['Godot 4', 'Puzzle', 'Algorithm Verified'],
		featured: false,
		links: [gh('snug-fit'), hub]
	},
	{
		name: 'Mirrorlock',
		year: '2026',
		blurb: 'Bilateral symmetry puzzle where pieces have mirrored twins. Sliding one mirrors the other unless blocked by obstacles. 360 levels in 9 chapters.',
		tags: ['Godot 4', 'Puzzle'],
		featured: false,
		links: [gh('mirrorlock'), hub]
	},
	{
		name: 'Corral',
		year: '2026',
		blurb: 'Endless enclosure strategy puzzle. Close pens to score area squared, featuring daily challenges verified by an automated bot.',
		tags: ['Godot 4', 'Puzzle', 'Daily Challenge'],
		featured: false,
		links: [gh('corral'), hub]
	},
];
