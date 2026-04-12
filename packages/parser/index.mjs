import { analyzeProject, DEFAULT_SCAN_OPTIONS } from '../../scripts/ai-brain/lib/project-analysis.mjs';

export function buildScanOptions(overrides = {}) {
  return {
    ...DEFAULT_SCAN_OPTIONS,
    maxDepth: Number(overrides.maxDepth ?? DEFAULT_SCAN_OPTIONS.maxDepth),
    maxFiles: Number(overrides.maxFiles ?? DEFAULT_SCAN_OPTIONS.maxFiles),
    maxDirectories: Number(overrides.maxDirectories ?? DEFAULT_SCAN_OPTIONS.maxDirectories),
    maxInterestingFiles: Number(overrides.maxInterestingFiles ?? DEFAULT_SCAN_OPTIONS.maxInterestingFiles),
    maxReadmeDocuments: Number(overrides.maxReadmeDocuments ?? DEFAULT_SCAN_OPTIONS.maxReadmeDocuments),
  };
}

export async function parseProject(projectRoot, options = {}) {
  const analysis = await analyzeProject(projectRoot, buildScanOptions(options));
  return {
    projectRoot,
    analysis,
    parsedAt: new Date().toISOString(),
  };
}