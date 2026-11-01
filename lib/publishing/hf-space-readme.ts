import { DEMO_URL } from '@/lib/constants/links';

function yamlString(value: string): string {
  // Quote when the value could be misparsed as YAML (contains : # etc. or leading/trailing space).
  if (/[:#\[\]{}",&*!|>%@`]|^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildSpaceReadme(opts: { title: string; shortDescription: string }): string {
  const title = yamlString(opts.title.trim() || 'Static site');
  const desc = oneLine(opts.shortDescription, 200);

  const frontmatter = [
    '---',
    `title: ${title}`,
    'emoji: 🌐',
    'colorFrom: gray',
    'colorTo: gray',
    'sdk: static',
    'pinned: false',
    ...(desc ? [`short_description: ${yamlString(desc)}`] : []),
    'tags:',
    '  - osw-studio',
    '---',
  ].join('\n');

  return `${frontmatter}\n\nBuilt with [OSW Studio](${DEMO_URL}).\n`;
}
