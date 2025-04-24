import core from '@actions/core';
import github from '@actions/github';
import YAML from "yaml";
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

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
async function runStepsInParallel(steps) {
  const worklfowFile = `${process.env.RUNNER_TEMP ?? '/tmp'}/${github.context.action}.yaml`;
  const workingDirectory = process.cwd();

  const workflow = {
    on: "workflow_dispatch",
    jobs: Object.assign({}, ...steps.map((step, index) => ({
      [`Step${index}`]: {
        "runs-on": "host",
        "steps": [
          {
            name: "Use host working directory",
            run : [
              `rm -rf $PWD`,
              `ln -s '${workingDirectory}' $PWD`,
              ].join('\n'),
          },
          step,
        ]
      }
    })))
  };
  fs.mkdirSync(path.dirname(worklfowFile), { recursive: true });
  fs.writeFileSync(worklfowFile, YAML.stringify(workflow));

  const stepResults = Object.fromEntries(Object.keys(workflow.jobs).map(jobId => [jobId, {
    stepId: jobId,
    step: null,
    status: null,
    output: "",
    executionTime: null,
  }]));

  const workflowProcess = child_process.spawn("gh", [
    "act",
    "--workflows", worklfowFile,
    "--platform", "host=-self-hosted",
    "--action-offline-mode",
    "--log-prefix-job-id",
    "--actor", github.context.actor,
    "-s", `GITHUB_TOKEN=${githubToken}`,
    // "--env-file", envFilePath,
    // "--eventpath", eventFilePath
    "--json",
    "--bind",
  ], {
    env: {
      ...process.env,
    },
  });

  {
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      console.log('');
      const step = job.steps[0];
      let stepName = step.name
      if(!stepName){
        if(step.uses) {
          stepName = step.uses;
        } else {
          stepName = step.run.split('\n')[0];
        }
      }
      core.startGroup(`[${jobId}] Run ${stepName}`);
      console.log(YAML.stringify({
        ...step,
        name: undefined,
        uses: undefined,
      }).replace(/\n$/, ''))
      core.endGroup();
    }
  }

  console.log('');
  core.startGroup("Output");

  readline.createInterface({input: workflowProcess.stdout, crlfDelay: Infinity})
    .on('line', newLineHandler(workflowProcess.stdout, stepResults));

  readline.createInterface({input: workflowProcess.stderr, crlfDelay: Infinity})
    .on('line', newLineHandler(workflowProcess.stderr, stepResults));

  workflowProcess.on("exit", () => {
    core.endGroup();
  });

  return new Promise((resolve, reject) => {

    // close vs exit => https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
    workflowProcess.on("close", (exitCode) => {
        // grouped output
        // TODO HANDLE ::set-output:: and co
        console.log('');
        Object.entries(stepResults).forEach(([stepId, stepResult]) => {
          let groupHeadline = `[${stepResult.stepId}] ` + buildStepStatusLine(stepResult);
          core.startGroup(groupHeadline);
          console.log(stepResult.output.replace(/\n$/, ''));
          core.endGroup();
          console.log(''); // Add an empty line after each group
      });

      if (exitCode !== 0){
        reject();
      } else {
        resolve();
      }
    });
  })
}

function newLineHandler(outputStream, stepResults) {
  return (line) => {
    try {
      line = JSON.parse(line);
    } catch (error) {
      return;
    }
    if(!line.jobID) {
      return;
    }

    const stepResult = stepResults[line.jobID];

    if(line.stage === "Pre") {
      stepResult.step = line.step;
      if(line.level === 'info' || line.level === 'warn' || line.level === 'error') {
        const msg = adjustMessage(line.msg);
        console.log(`[${line.jobID}] [${line.stage}] ${msg}`);
        stepResult.output += `[${line.stage}] ${ensureNewline(msg)}`;
      }
    } else if(line.stage === "Main") {
      stepResult.step = line.step;
      if(line.raw_output) {
        process.stdout.write(`[${line.jobID}] ${ensureNewline(line.msg)}`);
        stepResult.output += `${line.msg}`;
      }
    } else if(line.stage === "Post") {
      if(line.level === 'info' || line.level === 'warn' || line.level === 'error') {
        const msg = adjustMessage(line.msg);
        console.log(`[${line.jobID}] [${line.stage}] ${msg}`);
        stepResult.output += `[${line.stage}] ${ensureNewline(msg)}`;
      }
    } else if (line.jobResult) {
      stepResult.status = line.jobResult;
      stepResult.executionTime = line.executionTime;
      console.log(`[${line.jobID}] ${buildStepStatusLine(stepResult)}`);
    }
  }
}

function adjustMessage(msg) {
  return msg.replace(/^  ☁\s+/, '');
}

function buildStepStatusLine(stepResult) {
  let line = stepResult.status === 'success' ? '⚪️' : '🔴';
  line += ` Run ${stepResult.step}`
  if(stepResult.executionTime) {
    line +=` [${formatMilliseconds(stepResult.executionTime)})]`
  }
  return line
}

function ensureNewline(text) {
  return text.endsWith('\n') ? text : text + '\n';
}

function formatMilliseconds(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds >= 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }

  return parts.join(" ");
}
