import { DEFAULT_SCHEMA_EXTENSIONS } from '@/src/utils/schema-detection';

export interface ReviewPayload {
  baseSha?: string;
  catalogPath?: string;
  catalogRef?: string;
  catalogRepo?: string;
  catalogToken?: string;
  githubRepository?: string;
  githubToken?: string;
  headSha?: string;
  ignorePaths?: string[] | string;
  model?: string;
  prNumber?: number | string;
  schemaExtensions?: string[] | string;
  workspace?: string;
}

export interface GithubReviewTarget {
  owner: string;
  prNumber: number;
  repo: string;
  token: string;
}

export interface ReviewConfig {
  baseSha?: string;
  catalogPath: string;
  catalogRef: string;
  catalogRepo?: string;
  catalogToken?: string;
  github?: GithubReviewTarget;
  headSha?: string;
  ignorePaths: string[];
  model: string;
  /** Extensions (e.g. `.json`, `.js`) treated as message schemas by the breaking-changes agent. */
  schemaExtensions: string[];
  thinkingLevel: string;
  workspace: string;
}

export const DEFAULT_DIFF_IGNORE_PATHS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
  '.turbo',
  '.cache',
  '.vite',
  '.vercel',
  '.netlify',
  'out',
  'target',
  'bin',
  'obj',
  'vendor',
];

/** Parse a comma-separated string (or pass through an array), trimming and dropping empties. */
const parseCommaList = (value: string[] | string | undefined): string[] => {
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }

  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const parseGithubTarget = (payload: ReviewPayload, env: NodeJS.ProcessEnv): GithubReviewTarget | undefined => {
  const repository = payload.githubRepository || env.EVENTCATALOG_GITHUB_REPOSITORY || env.GITHUB_REPOSITORY;
  const token = payload.githubToken || env.EVENTCATALOG_GITHUB_TOKEN || env.GITHUB_TOKEN;
  const rawPrNumber = payload.prNumber || env.EVENTCATALOG_PR_NUMBER || env.GITHUB_PR_NUMBER;
  const prNumber = typeof rawPrNumber === 'number' ? rawPrNumber : Number.parseInt(rawPrNumber ?? '', 10);
  const [owner, repo] = (repository ?? '').split('/');

  if (!owner || !repo || !token || !Number.isInteger(prNumber)) {
    return undefined;
  }

  return { owner, prNumber, repo, token };
};

export const resolveConfig = (payload: ReviewPayload | undefined, env: NodeJS.ProcessEnv): ReviewConfig => {
  const p = payload ?? {};
  const ignorePaths = parseCommaList(p.ignorePaths ?? env.EVENTCATALOG_IGNORE_PATHS);
  const schemaExtensions = parseCommaList(p.schemaExtensions ?? env.EVENTCATALOG_SCHEMA_EXTENSIONS);

  return {
    baseSha: p.baseSha || env.EVENTCATALOG_BASE_SHA,
    catalogPath: p.catalogPath || env.EVENTCATALOG_CATALOG_PATH || 'eventcatalog',
    catalogRef: p.catalogRef || env.EVENTCATALOG_CATALOG_REF || 'main',
    catalogRepo: p.catalogRepo || env.EVENTCATALOG_CATALOG_REPO,
    catalogToken: p.catalogToken || env.EVENTCATALOG_CATALOG_TOKEN,
    github: parseGithubTarget(p, env),
    headSha: p.headSha || env.EVENTCATALOG_HEAD_SHA,
    ignorePaths: ignorePaths.length > 0 ? ignorePaths : DEFAULT_DIFF_IGNORE_PATHS,
    model: p.model || env.EVENTCATALOG_MODEL || env.MODEL || 'anthropic/claude-sonnet-4-6',
    schemaExtensions: schemaExtensions.length > 0 ? schemaExtensions : DEFAULT_SCHEMA_EXTENSIONS,
    thinkingLevel: env.THINKING_LEVEL || 'medium',
    workspace: p.workspace || env.GITHUB_WORKSPACE || env.WORKSPACE || process.cwd(),
  };
};
