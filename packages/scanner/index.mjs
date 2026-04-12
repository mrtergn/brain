import { parseProject } from '../parser/index.mjs';
import { normalizeProject } from '../normalizer/index.mjs';
import { listTopLevelProjectRoots, timestamp } from '../shared/index.mjs';

export async function scanWorkspace(config, { projectNames = [], includeBrain = false, force = false } = {}) {
  const startedAt = timestamp();
  const projectRoots = await listTopLevelProjectRoots(config.projectsRoot, {
    includeBrain,
    explicitProjects: projectNames,
  });
  const projects = [];
  const failures = [];

  for (const projectRoot of projectRoots) {
    try {
      const parsedProject = await parseProject(projectRoot, config);
      const normalizedProject = normalizeProject(parsedProject);
      projects.push({
        ...normalizedProject,
        forceRequested: force,
      });
    } catch (error) {
      failures.push({
        projectName: projectRoot.split('/').pop(),
        rootPath: projectRoot,
        error: error.message,
      });
    }
  }

  return {
    startedAt,
    completedAt: timestamp(),
    projects,
    failures,
  };
}