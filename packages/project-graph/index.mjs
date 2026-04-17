import { timestamp, uniqueStrings } from '../shared/index.mjs';

export function buildProjectGraph(projects = []) {
  const nodes = projects.map((project) => ({
    project: project.name,
    stack: (project.stack ?? []).slice(0, 10),
    validationSurfaces: (project.validationSurfaces ?? []).slice(0, 6),
    boundaries: (project.boundaryRules ?? []).slice(0, 6),
  }));

  const edges = [];
  for (let leftIndex = 0; leftIndex < projects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < projects.length; rightIndex += 1) {
      const left = projects[leftIndex];
      const right = projects[rightIndex];
      const reasons = [];
      const sharedStack = intersect(left.stack ?? [], right.stack ?? []);
      const sharedPatterns = intersect(left.architecture ?? [], right.architecture ?? []);
      const sharedDocs = intersect(left.documentationPatterns ?? [], right.documentationPatterns ?? []);
      if (sharedStack.length > 0) {
        reasons.push(`shared stack: ${sharedStack.slice(0, 3).join(', ')}`);
      }
      if (sharedPatterns.length > 0) {
        reasons.push(`shared architecture: ${sharedPatterns.slice(0, 2).join(', ')}`);
      }
      if (sharedDocs.length > 0) {
        reasons.push(`shared documentation patterns: ${sharedDocs.slice(0, 2).join(', ')}`);
      }
      if (reasons.length === 0) {
        continue;
      }
      const weight = Number((Math.min(sharedStack.length * 0.2, 0.6) + Math.min(sharedPatterns.length * 0.15, 0.3) + Math.min(sharedDocs.length * 0.1, 0.2)).toFixed(2));
      edges.push({
        from: left.name,
        to: right.name,
        relation: 'related-project',
        weight,
        reasons,
      });
    }
  }

  return {
    updatedAt: timestamp(),
    nodes,
    edges,
  };
}

export function getProjectNeighbors(graph = {}, projectName, limit = 4) {
  return (graph.edges ?? [])
    .filter((edge) => edge.from === projectName || edge.to === projectName)
    .map((edge) => ({
      project: edge.from === projectName ? edge.to : edge.from,
      relation: edge.relation,
      weight: edge.weight,
      reasons: uniqueStrings(edge.reasons ?? []),
    }))
    .sort((left, right) => Number(right.weight ?? 0) - Number(left.weight ?? 0))
    .slice(0, Math.max(Number(limit ?? 4), 1));
}

function intersect(left = [], right = []) {
  const rightSet = new Set((right ?? []).map((item) => String(item).toLowerCase()));
  return uniqueStrings((left ?? []).filter((item) => rightSet.has(String(item).toLowerCase())));
}
