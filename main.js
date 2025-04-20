import core from '@actions/core';
import github from '@actions/github';
import YAML from "yaml";
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const githubToken = core.getInput("token", { required: true });
// Get steps from input
const steps = YAML.parse(core.getInput("steps", { required: true }));
// TODO validate steps
if (!Array.isArray(steps)) {
  throw new Error("steps must be an array");
}

// Install gh-act extension
child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
  env: {
    ...process.env,
    GH_TOKEN: githubToken,
  },
});
// Run all steps in parallel
await runStepsInParallel(steps).catch(() => {
  core.setFailed("One or more parallel steps failed");
});

// ----------------------------------------------------------------
//
function runStepsInParallel(steps) {
  const worklfowFile = `${process.env.RUNNER_TEMP ?? '/tmp'}/${github.context.action}.yaml`;
  const workflow = {
    on: "workflow_dispatch",
    jobs:  Object.assign({}, ...steps.map((step, index) => ({
      [`Step${index}`]: {
        "runs-on": "host",
        "steps": [step]
      }
    })))
  };
  fs.mkdirSync(path.dirname(worklfowFile), { recursive: true });
  fs.writeFileSync(worklfowFile, YAML.stringify(workflow));

  core.startGroup("Output");

  const workflowProcess = child_process.spawn("gh", [
    "act",
    "--workflows", worklfowFile,
    "--platform", "host=-self-hosted",
    "--action-offline-mode",
    "--log-prefix-job-id",
    "--actor", github.context.actor,
    "-s", `GITHUB_TOKEN=${githubToken}`
    // "--env-file", envFilePath,
    // "--eventpath", eventFilePath
  ], {
    env: {
      ...process.env,
    },
  });


  return new Promise((resolve, reject) => {
    let stepOutput = Object.fromEntries(Object.keys(workflow.jobs).map(jobId => [jobId, ""]));

    let stdoutChunkStack = "";
    workflowProcess.stdout.on("data", (chunk) => {
      stdoutChunkStack += chunk.toString();
      const stdoutChunkStackLines = stdoutChunkStack.split("\n")
      for (const line of stdoutChunkStackLines.slice(0, -1)) {
        const parsedLine = parseLine(line);
        if(parsedLine.level == 'info') {
          process.stdout.write(parsedLine.line);
          stepOutput[parsedLine.jobId] += parsedLine.line;
        }
      }

      stdoutChunkStack = stdoutChunkStackLines.slice(-1)[0] ?? "";
    });

    let stderrChunkStack = "";
    workflowProcess.stderr.on("data", (chunk) => {
      stderrChunkStack += chunk.toString();
      const stderrChunkStackLines = stderrChunkStack.split("\n")
      for (const line of stderrChunkStackLines.slice(0, -1)) {
        const parsedLine = parseLine(line);
        if(parsedLine.level == 'info') {
          process.stderr.write(parsedLine.line);
          stepOutput[parsedLine.jobId] += parsedLine.line;
        }
      }

      stderrChunkStack = stderrChunkStackLines.slice(-1)[0] ?? "";
    });

    // TODO https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
    // p.on("close", resolve);
    workflowProcess.on("exit", (exitCode) => {
      const parsedStdoutChunkStack = parseLine(stdoutChunkStack);
      if(parsedStdoutChunkStack.level == 'info') {
        process.stdout.write(parsedStdoutChunkStack.line);
        stepOutput[parsedStdoutChunkStack.jobId] += parsedStdoutChunkStack.line;
      }

      const parsedStderrtChunkStack = parseLine(stderrChunkStack);
      if(parsedStderrtChunkStack.level == 'info') {
        process.stderr.write(parsedStderrtChunkStack.line);
        stepOutput[parsedStderrtChunkStack.jobId] += parsedStderrtChunkStack.line;
      }

      core.endGroup();

      // grouped output
      console.log('');
      Object.entries(stepOutput).forEach(([jobId, output]) => {
        const formatedOutputLines = output.split('\n')
          .map(line => line.replace(/^\[[^\]]+]\s*/, ''));

        core.startGroup(' ' + formatedOutputLines.slice(-2)[0]);
        console.log(formatedOutputLines.slice(1,-2).join('\n'));
        core.endGroup();
        console.log(''); // Add an empty line after each group
      });

      if (exitCode !== 0){
        reject();
      } else {
        resolve();
      }
    });

    function parseLine(line) {
      const lineMatch = line.trim().match(/^\[(?<jobId>Step\d+)]\s*(?<msg>.*)/)
      if(!lineMatch) {
        return {
          jobId: null,
          line
        };
      }

      if(!(lineMatch.groups.msg.startsWith("⭐ Run Main")
        || lineMatch.groups.msg.startsWith("|")
        || lineMatch.groups.msg.startsWith("✅  Success - Main")
        || lineMatch.groups.msg.startsWith("❌  Failure - Main"))) {
        return {
          jobId: null,
          line
        };
      }

      const jobId = lineMatch.groups.jobId;
      const msg = lineMatch.groups.msg
        .replace(/^⭐ Run Main/, '▷ Run')
        .replace(/^✅  Success - Main/, '⚪️ Run') // ✔︎
        .replace(/^❌  Failure - Main/, '🔴 Failure')
        .replace(/^\|\s*/, '') ;

      return {
        jobId,
        line: `[${jobId}] ${msg}\n`,
        level: 'info'
      }
    }
  });
}
