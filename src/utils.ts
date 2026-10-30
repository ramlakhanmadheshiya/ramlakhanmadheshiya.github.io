import { getCollection } from 'astro:content';

export async function getPosts() {
	const posts = await getCollection('blog', ({ data }) => !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export const fmtDate = (d: Date) =>
	d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const readingTime = (text: string) => Math.max(1, Math.round(text.split(/\s+/).length / 220));
