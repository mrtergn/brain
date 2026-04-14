import {
  createEvidenceItem,
  createEvidenceSource,
  flattenProvenanceRecords,
  maxEvidenceConfidence,
  maxEvidenceQuality,
  pickTopEvidenceItems,
  summarizeEvidenceItem,
} from '../provenance/index.mjs';
import { sha256, truncate } from '../shared/index.mjs';

const DEFAULT_MAX_CHARS = 1100;
const DEFAULT_OVERLAP_CHARS = 140;

export function buildProjectKnowledgeSources(project, noteContents = {}) {
  const sources = [
    {
      noteType: 'normalized-project',
      sourcePath: project.rootPath,
      sourceKind: 'project-snapshot',
      knowledgeType: 'project-snapshot',
      knowledgeStrength: 'medium',
      provenanceItems: flattenProvenanceRecords(project.provenance ?? {}),
      tags: project.tags,
      text: project.corpusText,
    },
  ];

  for (const [noteType, payload] of Object.entries(noteContents)) {
    if (!payload?.text) {
      continue;
    }
    const sourceAssessment = assessNoteSource({ noteType, sourcePath: payload.sourcePath, text: payload.text });
    sources.push({
      noteType,
      sourcePath: payload.sourcePath,
      sourceKind: sourceAssessment.sourceKind,
      knowledgeType: sourceAssessment.knowledgeType,
      knowledgeStrength: sourceAssessment.knowledgeStrength,
      provenanceItems: sourceAssessment.provenanceItems,
      tags: payload.tags ?? project.tags,
      text: payload.text,
    });
  }

  return sources;
}

export function chunkProjectKnowledge(project, sources, options = {}) {
  const maxChars = Number(options.maxChars ?? DEFAULT_MAX_CHARS);
  const overlapChars = Number(options.overlapChars ?? DEFAULT_OVERLAP_CHARS);
  const chunks = [];

  for (const source of sources) {
    const sourceChunks = splitIntoChunks(source.text, maxChars, overlapChars);
    for (let index = 0; index < sourceChunks.length; index += 1) {
      const text = sourceChunks[index];
      const chunkId = sha256(`${project.name}:${source.noteType}:${source.sourcePath}:${index}:${text}`);
      const chunkProvenance = selectChunkProvenance(source, text);
      chunks.push({
        id: chunkId,
        chunkId,
        project: project.name,
        noteType: source.noteType,
        sourcePath: source.sourcePath,
        sourceKind: source.sourceKind,
        knowledgeType: source.knowledgeType,
        knowledgeStrength: source.knowledgeStrength,
        content: text,
        preview: truncate(text.replace(/\s+/g, ' '), 220),
        tags: source.tags ?? [],
        provenance: chunkProvenance,
        metadata: {
          project: project.name,
          noteType: source.noteType,
          sourcePath: source.sourcePath,
          sourceKind: source.sourceKind,
          knowledgeType: source.knowledgeType,
          knowledgeStrength: source.knowledgeStrength,
          evidenceQuality: chunkProvenance.evidenceQuality,
          confidence: chunkProvenance.confidence,
          supportCount: chunkProvenance.supportCount,
          evidenceSummary: chunkProvenance.evidenceSummary,
          supportingSources: JSON.stringify(chunkProvenance.supportingSources),
          derivedFrom: chunkProvenance.derivedFrom.join(' | '),
          chunkId,
          tags: source.tags ?? [],
          fingerprint: project.fingerprint,
          updatedAt: project.normalizedAt,
        },
      });
    }
  }

  return chunks;
}

function assessNoteSource({ noteType, sourcePath, text }) {
  const firstHeading = extractFirstHeading(text);
  const selfSource = createEvidenceSource({
    sourcePath,
    sourceKind: 'note',
    sourceSection: firstHeading,
    excerpt: extractEvidenceExcerpt(text),
  });

  if (noteType === 'learnings') {
    const structured = /\*\*Problem\*\*[\s\S]*?\*\*Solution\*\*[\s\S]*?\*\*Reusable Pattern\*\*/i.test(text);
    return {
      sourceKind: 'note',
      knowledgeType: structured ? 'proven-learning' : 'learning-note',
      knowledgeStrength: structured ? 'strong' : 'medium',
      provenanceItems: [createEvidenceItem({
        category: 'learnings',
        value: structured
          ? 'Structured learning note with explicit Problem, Solution, and Reusable Pattern sections.'
          : 'Learning note captured in project memory.',
        sources: [selfSource],
        derivedFrom: 'note-structure',
        evidenceQuality: structured ? 'strong' : 'medium',
        confidence: structured ? 0.88 : 0.72,
      })].filter(Boolean),
    };
  }

  if (noteType === 'prompts') {
    return {
      sourceKind: 'note',
      knowledgeType: 'guidance-note',
      knowledgeStrength: 'medium',
      provenanceItems: [createEvidenceItem({
        category: 'prompts',
        value: 'Prompt note encodes safe-change and debugging guidance for this project.',
        sources: [selfSource],
        derivedFrom: 'manual-note',
        evidenceQuality: 'medium',
        confidence: 0.74,
      })].filter(Boolean),
    };
  }

  if (noteType === 'architecture') {
    return {
      sourceKind: 'note',
      knowledgeType: 'architecture-note',
      knowledgeStrength: 'medium',
      provenanceItems: [createEvidenceItem({
        category: 'architecture-note',
        value: 'Architecture note summarizes runtime structure, interfaces, and validation surfaces.',
        sources: [selfSource],
        derivedFrom: 'manual-note',
        evidenceQuality: 'medium',
        confidence: 0.76,
      })].filter(Boolean),
    };
  }

  return {
    sourceKind: 'note',
    knowledgeType: 'project-note',
    knowledgeStrength: 'medium',
    provenanceItems: [createEvidenceItem({
      category: noteType,
      value: `${noteType} note contributes project-specific guidance.`,
      sources: [selfSource],
      derivedFrom: 'manual-note',
      evidenceQuality: 'medium',
      confidence: 0.7,
    })].filter(Boolean),
  };
}

function selectChunkProvenance(source, text) {
  const provenanceItems = source.provenanceItems ?? [];
  const matched = provenanceItems.filter((item) => chunkMatchesEvidenceItem(text, item));
  const highlighted = pickTopEvidenceItems(matched.length > 0 ? matched : provenanceItems, 3);
  const supportingSources = highlighted
    .flatMap((item) => item.sources ?? [])
    .slice(0, 4)
    .map((entry) => ({
      sourcePath: entry.sourcePath,
      sourceKind: entry.sourceKind,
      sourceSection: entry.sourceSection,
      excerpt: entry.excerpt,
    }));

  return {
    evidenceQuality: maxEvidenceQuality(highlighted),
    confidence: Number(maxEvidenceConfidence(highlighted).toFixed(4)),
    supportCount: supportingSources.length,
    evidenceSummary: highlighted.map((item) => summarizeEvidenceItem(item)).join(' | '),
    supportingSources,
    derivedFrom: [...new Set(highlighted.map((item) => item.derivedFrom).filter(Boolean))],
  };
}

function chunkMatchesEvidenceItem(text, item) {
  const normalizedText = String(text ?? '').toLowerCase();
  const normalizedValue = String(item?.value ?? '').toLowerCase();
  if (!normalizedText || !normalizedValue) {
    return false;
  }
  if (normalizedText.includes(normalizedValue) || normalizedValue.includes(normalizedText.slice(0, Math.min(normalizedText.length, 80)))) {
    return true;
  }
  const valueTokens = tokenizeEvidenceText(normalizedValue);
  if (valueTokens.length === 0) {
    return false;
  }
  let matches = 0;
  for (const token of valueTokens) {
    if (normalizedText.includes(token)) {
      matches += 1;
    }
  }
  return (matches / valueTokens.length) >= 0.45;
}

function extractFirstHeading(text) {
  return String(text ?? '').match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function extractEvidenceExcerpt(text) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), 180);
}

function tokenizeEvidenceText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function splitIntoChunks(text, maxChars, overlapChars) {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }
    const candidate = `${current}\n\n${paragraph}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = createOverlap(current, overlapChars, paragraph);
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.flatMap((chunk) => splitLongChunk(chunk, maxChars, overlapChars));
}

function createOverlap(previous, overlapChars, paragraph) {
  const overlap = previous.slice(Math.max(0, previous.length - overlapChars)).trim();
  return overlap ? `${overlap}\n\n${paragraph}` : paragraph;
}

function splitLongChunk(text, maxChars, overlapChars) {
  if (text.length <= maxChars) {
    return [text];
  }
  const result = [];
  let cursor = 0;
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    result.push(text.slice(cursor, end).trim());
    if (end === text.length) {
      break;
    }
    cursor = Math.max(0, end - overlapChars);
  }
  return result.filter(Boolean);
}