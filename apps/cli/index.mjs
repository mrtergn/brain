#!/usr/bin/env node

import { parseArgs, extractProjectNames } from '../../packages/shared/index.mjs';
import { shutdownEmbeddingService } from '../../packages/embeddings/index.mjs';
import {
  runConsult,
  runDoctor,
  runEmbed,
  runInit,
  runLearn,
  runQuery,
  runScan,
  runStatus,
  runSync,
  runValidateVault,
  runWatch,
} from '../worker/index.mjs';

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'status';
  const baseOptions = {
    configPath: args.config,
    projectsRoot: args['projects-root'],
    vaultRoot: args['vault-root'],
    dataRoot: args['data-root'],
    cacheRoot: args['cache-root'],
    chromaRoot: args['chroma-root'],
    logRoot: args['log-root'],
    statePath: args['state-path'],
    watchMode: args['watch-mode'],
    pollIntervalMs: args['poll-interval'],
    projectNames: extractProjectNames(args),
    includeBrain: Boolean(args['include-brain']),
    force: Boolean(args.force),
    topK: args['top-k'],
    pythonExecutable: args.python,
  };

  try {
    switch (command) {
      case 'init': {
        const payload = await runInit(baseOptions);
        console.log(`Brain initialized.`);
        console.log(`Config file: ${payload.config.configFilePath ?? 'none'}`);
        console.log(`Projects root: ${payload.config.projectsRoot}`);
        console.log(`Vault root: ${payload.config.vaultRoot}`);
        console.log(`Data root: ${payload.config.dataRoot}`);
        console.log(`Chroma root: ${payload.config.chromaRoot}`);
        console.log(`Log root: ${payload.config.logRoot}`);
        console.log(`Runtime state: ${payload.config.statePath}`);
        console.log(`Generated runners: ${payload.config.runtimeRoot}`);
        return;
      }
      case 'scan': {
        const payload = await runScan(baseOptions);
        console.log(`Scan completed at ${payload.scanResult.completedAt}`);
        console.log(`Projects scanned: ${payload.scanResult.projects.length}`);
        console.log(`Changed projects: ${payload.changedProjects.join(', ') || 'none'}`);
        if (payload.scanResult.failures.length > 0) {
          console.log(`Failures: ${payload.scanResult.failures.length}`);
        }
        return;
      }
      case 'sync': {
        const payload = await runSync(baseOptions);
        console.log(`Sync completed at ${payload.syncSummary.completedAt}`);
        console.log(`Updated projects: ${payload.syncSummary.updatedProjects.join(', ') || 'none'}`);
        console.log(`Unchanged projects: ${payload.syncSummary.unchangedProjects.length}`);
        return;
      }
      case 'embed': {
        const payload = await runEmbed(baseOptions);
        console.log(`Embed completed at ${payload.state.lastEmbedAt}`);
        console.log(`Embedded projects: ${payload.embeddedProjects.map((project) => project.name).join(', ') || 'none'}`);
        return;
      }
      case 'query': {
        const queryText = String(args.query ?? args._.slice(1).join(' ')).trim();
        const payload = await runQuery({ ...baseOptions, queryText });
        console.log(`Mode: ${payload.reasoning.mode}`);
        console.log(`Related projects: ${payload.reasoning.relatedProjects.join(', ') || 'none'}`);
        console.log('Top results:');
        for (const result of payload.retrievalResponse.results.slice(0, 5)) {
          console.log(`- ${result.project}/${result.noteType} | score=${result.relevanceScore} | ${result.snippet}`);
          console.log(`  matched: ${result.whyMatched}`);
          console.log(`  trusted: ${result.whyTrusted}`);
        }
        console.log('Suggestions:');
        for (const suggestion of payload.reasoning.solutionSuggestions) {
          console.log(`- ${suggestion}`);
        }
        return;
      }
      case 'consult': {
        const queryText = String(args.query ?? args._.slice(1).join(' ')).trim();
        const payload = await runConsult({ ...baseOptions, queryText, currentProjectName: baseOptions.projectNames?.[0] ?? null });
        console.log(`Mode: ${payload.consultation.mode}`);
        console.log(`Local confidence: ${payload.consultation.localConfidence.score} (${payload.consultation.localConfidence.level})`);
        console.log(`Web research required: ${payload.consultation.researchDecision.needsWebResearch ? 'yes' : 'no'}`);
        console.log('Why:');
        for (const reason of payload.consultation.researchDecision.rationale) {
          console.log(`- ${reason}`);
        }
        if (payload.consultation.trustSummary?.strongestBasis?.length > 0) {
          console.log('Trust basis:');
          for (const reason of payload.consultation.trustSummary.strongestBasis) {
            console.log(`- ${reason}`);
          }
        }
        console.log('Recommended approach:');
        for (const line of payload.consultation.synthesis.recommendedProjectApproach) {
          console.log(`- ${line}`);
        }
        if (payload.consultation.researchPlan.sourceTargets.length > 0) {
          console.log('Sources to prioritize:');
          for (const source of payload.consultation.researchPlan.sourceTargets) {
            console.log(`- ${source.tier} | ${source.label} | ${source.reason}`);
          }
        }
        return;
      }
      case 'learn': {
        const payload = await runLearn(baseOptions);
        console.log(`Learn completed at ${payload.state.lastLearnAt}`);
        console.log(`Projects included: ${payload.projects.map((project) => project.name).join(', ') || 'none'}`);
        return;
      }
      case 'doctor': {
        const payload = await runDoctor(baseOptions);
        console.log(payload.summary);
        if (payload.warnings.length > 0) {
          console.log('Warnings:');
          for (const warning of payload.warnings) {
            console.log(`- ${warning}`);
          }
        }
        if (payload.issues.length > 0) {
          console.log('Issues:');
          for (const issue of payload.issues) {
            console.log(`- ${issue}`);
          }
          process.exitCode = 1;
        }
        if (payload.queryCheck) {
          console.log(`Query smoke: ${payload.queryCheck.resultCount} result(s), note types: ${payload.queryCheck.topNoteTypes.join(', ') || 'none'}`);
        }
        if (payload.consultCheck) {
          console.log(`Consult smoke: mode=${payload.consultCheck.mode}, web research=${payload.consultCheck.needsWebResearch ? 'yes' : 'no'}`);
        }
        if (payload.mcpHealth.ok) {
          console.log(`MCP health: tools=${payload.mcpHealth.tools.join(', ')}`);
        }
        return;
      }
      case 'validate-vault': {
        const payload = await runValidateVault(baseOptions);
        console.log(payload.reportText);
        if (!payload.report.ok) {
          process.exitCode = 1;
        }
        return;
      }
      case 'watch': {
        await runWatch(baseOptions);
        return;
      }
      case 'status': {
        const payload = await runStatus(baseOptions);
        console.log(`Config file: ${payload.config.configFilePath ?? 'none'}`);
        console.log(`Projects root: ${payload.config.projectsRoot}`);
        console.log(`Vault root: ${payload.config.vaultRoot}`);
        console.log(`Data root: ${payload.config.dataRoot}`);
        console.log(`Chroma root: ${payload.config.chromaRoot}`);
        console.log(`Log root: ${payload.config.logRoot}`);
        console.log(`State path: ${payload.config.statePath}`);
        console.log(`Last scan: ${payload.state.lastScanAt ?? 'never'}`);
        console.log(`Last sync: ${payload.state.lastSyncAt ?? 'never'}`);
        console.log(`Last embed: ${payload.state.lastEmbedAt ?? 'never'}`);
        console.log(`Last learn: ${payload.state.lastLearnAt ?? 'never'}`);
        console.log(`Vector store: ${payload.vectorStatus.ok === false ? payload.vectorStatus.error : 'ready'}`);
        console.log('Projects:');
        for (const project of Object.values(payload.state.projects).sort((left, right) => left.name.localeCompare(right.name))) {
          console.log(`- ${project.name} | ${project.status ?? 'unknown'} | chunks=${project.chunkCount ?? 0}`);
        }
        return;
      }
      default:
        printUsage();
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    if (command !== 'watch') {
      await shutdownEmbeddingService();
    }
  }
}

function printUsage() {
  console.log('Usage: node apps/cli/index.mjs <command> [options]');
  console.log('Daily workflow: init -> sync -> validate-vault -> embed -> consult/query -> status');
  console.log('Commands:');
  console.log('  Core: init, sync, embed, query, consult, status, validate-vault');
  console.log('  Readiness: doctor');
  console.log('  Secondary: scan, learn, watch');
  console.log('Options:');
  console.log('  --config <path>           Optional local brain.config.json path');
  console.log('  --projects-root <path>    Override source projects root');
  console.log('  --vault-root <path>       Override Obsidian vault root');
  console.log('  --data-root <path>        Override runtime data root');
  console.log('  --cache-root <path>       Override cache root');
  console.log('  --chroma-root <path>      Override Chroma storage path');
  console.log('  --log-root <path>         Override log directory');
  console.log('  --state-path <path>       Override runtime state file');
  console.log('  --project <name[,name]>   Limit to one or more top-level projects');
  console.log('  --include-brain           Include the brain repo during scans');
  console.log('  --force                   Force regeneration or re-embedding');
  console.log('  --top-k <count>           Retrieval result count for query');
  console.log('  --watch-mode <mode>       auto | native | poll');
  console.log('  --poll-interval <ms>      Poll interval for watch mode');
  console.log('  --python <path>           Python executable for the Chroma sidecar');
}

if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}