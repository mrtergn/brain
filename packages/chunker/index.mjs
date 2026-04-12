import { sha256, truncate } from '../shared/index.mjs';

const DEFAULT_MAX_CHARS = 1100;
const DEFAULT_OVERLAP_CHARS = 140;

export function buildProjectKnowledgeSources(project, noteContents = {}) {
  const sources = [
    {
      noteType: 'normalized-project',
      sourcePath: project.rootPath,
      tags: project.tags,
      text: project.corpusText,
    },
  ];

  for (const [noteType, payload] of Object.entries(noteContents)) {
    if (!payload?.text) {
      continue;
    }
    sources.push({
      noteType,
      sourcePath: payload.sourcePath,
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
      chunks.push({
        id: chunkId,
        chunkId,
        project: project.name,
        noteType: source.noteType,
        sourcePath: source.sourcePath,
        content: text,
        preview: truncate(text.replace(/\s+/g, ' '), 220),
        tags: source.tags ?? [],
        metadata: {
          project: project.name,
          noteType: source.noteType,
          sourcePath: source.sourcePath,
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