import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_OVERVIEW_SECTIONS = [
  'Current Status',
  'Active Risks',
  'Next Safe Move',
  'Recent Decisions',
  'Do Not Break',
  'Key Commands',
  'Related Patterns',
];

const REQUIRED_PROJECT_FRONTMATTER_FIELDS = [
  'type',
  'project',
  'managed_by',
  'updated',
];

const RAW_QUERY_HISTORY_PATTERNS = [
  /^##\s+Recent Queries$/m,
  /^##\s+Projects Recalled Most Often$/m,
  /^-\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:/m,
  /\|\s+projects:\s+/m,
  /\|\s+mode:\s+/m,
  /Strict failure-recovery/i,
  /safe place in this repo to change retry logic/i,
  /best practice for token refresh handling/i,
];

const CURATED_QUERY_HISTORY_SECTIONS = [
  'Useful Query Patterns',
  'What Belongs Here',
  'What Stays In Runtime State',
  'Promotion Criteria',
  'Last Curated',
];

const JUNK_EXTENSIONS = new Set(['.tmp', '.temp', '.swp', '.swo']);
const BARE_PROJECT_LINKS = [
  'brain',
  'baht',
  'orchestrum',
  'tetik',
  'flutter',
  'RewindForge',
  'Troax',
  'troaxsafetywear',
  'polymarket-bot',
  'crossbook-arb-engine',
  'baht-prod-files',
  'CosmicSort',
  'the-game-lies',
];

async function main() {
  const vaultRoot = process.argv[2];
  if (!vaultRoot) {
    console.error('Usage: node scripts/validate-vault-hardening.mjs <vault-root>');
    process.exit(1);
  }

  const absoluteVaultRoot = path.resolve(vaultRoot);
  const markdownFiles = [];
  const junkArtifacts = [];
  const macosxFolders = [];
  await walk(absoluteVaultRoot, async (entryPath, entry) => {
    const relativePath = normalizeRelativePath(path.relative(absoluteVaultRoot, entryPath));
    if (entry.isDirectory() && entry.name === '__MACOSX') {
      macosxFolders.push(relativePath);
      return;
    }
    if (entry.isFile()) {
      if (entry.name === '.DS_Store' || JUNK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) || entry.name.endsWith('~')) {
        junkArtifacts.push(relativePath);
      }
      if (entry.name.endsWith('.md')) {
        markdownFiles.push(relativePath);
      }
    }
  });

  const markdownSet = new Set(markdownFiles.map((relativePath) => relativePath.replace(/\.md$/i, '')));
  const byStem = buildStemIndex(markdownFiles);

  let frontmatterCount = 0;
  const brokenWikilinks = [];
  const ambiguousWikilinks = [];
  const bareProjectLinks = [];
  const managedProjectNotesMissingFrontmatter = [];
  const managedProjectNotesMissingFields = [];
  const overviewsMissingSections = [];
  const filesWithFrontmatter = [];

  for (const relativePath of markdownFiles) {
    const absolutePath = path.join(absoluteVaultRoot, relativePath);
    const content = await fs.readFile(absolutePath, 'utf8');
    const parsedFrontmatter = parseFrontmatter(content);
    if (parsedFrontmatter) {
      frontmatterCount += 1;
      filesWithFrontmatter.push(relativePath);
    }

    collectWikilinkIssues({
      relativePath,
      content,
      markdownSet,
      byStem,
      brokenWikilinks,
      ambiguousWikilinks,
      bareProjectLinks,
    });

    const projectNoteMatch = relativePath.match(/^01_Projects\/([^/]+)\/(overview|architecture|learnings|prompts)\.md$/);
    if (projectNoteMatch) {
      const [, projectName, noteType] = projectNoteMatch;
      if (!parsedFrontmatter) {
        managedProjectNotesMissingFrontmatter.push(relativePath);
      } else {
        const missingFields = REQUIRED_PROJECT_FRONTMATTER_FIELDS.filter((field) => !Object.hasOwn(parsedFrontmatter.fields, field));
        if (noteType === 'overview' && !Object.hasOwn(parsedFrontmatter.fields, 'status')) {
          missingFields.push('status');
        }
        if (missingFields.length > 0) {
          managedProjectNotesMissingFields.push({ path: relativePath, missingFields: unique(missingFields) });
        }
        if (parsedFrontmatter.fields.project && parsedFrontmatter.fields.project !== projectName) {
          managedProjectNotesMissingFields.push({ path: relativePath, missingFields: [`project=${parsedFrontmatter.fields.project}`] });
        }
      }

      if (noteType === 'overview') {
        const missingSections = REQUIRED_OVERVIEW_SECTIONS.filter((section) => !new RegExp(`^##\\s+${escapeRegExp(section)}$`, 'm').test(content));
        if (missingSections.length > 0) {
          overviewsMissingSections.push({ path: relativePath, missingSections });
        }
      }
    }
  }

  const queryHistoryRelativePath = normalizeRelativePath(path.join('03_Agent_Notes', 'query-history.md'));
  const queryHistoryPath = path.join(absoluteVaultRoot, queryHistoryRelativePath);
  const queryHistoryContent = await fs.readFile(queryHistoryPath, 'utf8');
  const queryHistoryIndicators = RAW_QUERY_HISTORY_PATTERNS.filter((pattern) => pattern.test(queryHistoryContent)).map((pattern) => pattern.toString());
  const queryHistoryMissingSections = CURATED_QUERY_HISTORY_SECTIONS.filter((section) => !new RegExp(`^##\\s+${escapeRegExp(section)}$`, 'm').test(queryHistoryContent));

  const summary = {
    vaultRoot: absoluteVaultRoot,
    markdownCount: markdownFiles.length,
    frontmatterCount,
    filesWithFrontmatter: filesWithFrontmatter.length,
    managedProjectNotesMissingFrontmatter,
    managedProjectNotesMissingFields,
    brokenWikilinks,
    ambiguousWikilinks,
    dsStoreFiles: junkArtifacts.filter((relativePath) => path.basename(relativePath) === '.DS_Store'),
    macosxFolders,
    junkArtifacts,
    rawQueryHistoryIndicators: queryHistoryIndicators,
    queryHistoryMissingSections,
    bareProjectLinks,
    overviewsMissingSections,
  };

  console.log(JSON.stringify(summary, null, 2));
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) {
    return null;
  }
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return null;
  }
  const raw = content.slice(4, endIndex).trim();
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    fields[key] = rawValue.replace(/^"|"$/g, '').trim();
  }
  return { raw, fields };
}

function collectWikilinkIssues({ relativePath, content, markdownSet, byStem, brokenWikilinks, ambiguousWikilinks, bareProjectLinks }) {
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const rawTarget = String(match[1] ?? '');
    const candidate = rawTarget.split('|')[0].split('#')[0].trim();
    if (!candidate || /^https?:/i.test(candidate)) {
      continue;
    }
    if (BARE_PROJECT_LINKS.includes(candidate)) {
      bareProjectLinks.push({ path: relativePath, link: rawTarget });
    }
    const normalized = normalizeRelativePath(candidate.replace(/\.md$/i, ''));
    if (markdownSet.has(normalized)) {
      continue;
    }
    const stem = path.posix.basename(normalized);
    const stemMatches = byStem.get(stem) ?? [];
    if (stemMatches.length === 1) {
      continue;
    }
    const payload = { path: relativePath, link: rawTarget };
    if (stemMatches.length > 1) {
      ambiguousWikilinks.push({ ...payload, candidates: stemMatches });
    } else {
      brokenWikilinks.push(payload);
    }
  }
}

function buildStemIndex(markdownFiles) {
  const index = new Map();
  for (const relativePath of markdownFiles) {
    const stem = path.posix.basename(relativePath, '.md');
    const notePath = relativePath.replace(/\.md$/i, '');
    index.set(stem, [...(index.get(stem) ?? []), notePath]);
  }
  return index;
}

async function walk(rootPath, visitor) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    await visitor(entryPath, entry);
    if (entry.isDirectory() && entry.name !== '__MACOSX') {
      await walk(entryPath, visitor);
    }
  }
}

function normalizeRelativePath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function escapeRegExp(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set(values)];
}

await main();