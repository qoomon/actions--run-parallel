import core from '@actions/core';
import github from '@actions/github';
import YAML from 'yaml';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const WORKING_DIRECTORY = process.cwd();
const GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES = [
    "GITHUB_OUTPUT",
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
];

const githubToken = core.getInput("token", { required: true });
// Get steps from input
const steps = YAML.parse(core.getInput("steps", { required: true }));

if (!Array.isArray(steps)) {
  throw new Error("steps must be an array");
}

// Install gh-act extension
child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
  env: {...process.env, GH_TOKEN: githubToken},
});

await runStepsInParallel(steps).catch(() => {
  core.setFailed("One or more parallel steps failed");
});

// ----------------------------------------------------------------

// GITHUB_PATH
// GITHUB_ENV
// GITHUB_OUTPUT
// GITHUB_STEP_SUMMARY


async function runStepsInParallel(steps) {
  const workflowFile = `${process.env.RUNNER_TEMP ?? '/tmp'}/${github.context.action}.yaml`;
  const commandFilesDir = `${process.env.RUNNER_TEMP ?? '/tmp'}/${github.context.action}`;
  fs.mkdirSync(commandFilesDir, { recursive: true });
  const workflow = {
    on: "workflow_dispatch",
    jobs: Object.assign({}, ...steps
      .map((step, index) => [`Step${index}`, step])
      .map(([jobId, step]) => ({
        [jobId]: {
          "runs-on": "host",
          "steps": [
            {
              name: "Link job working directory to host working directory",
              run : [
                'rm -rf "$PWD"',
                `ln -s '${WORKING_DIRECTORY}' "$PWD"`,
                ].join('\n'),
            },
            {
              run : GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES.map((varName) => [
                      `rm -f "$${varName}"`,
                      `ln -s '${commandFilesDir}/${jobId}+${varName}' "$${varName}"`,
              ]).flat().join('\n'),
            },
            step,
          ]
        }
      }))
    )
  };
  fs.mkdirSync(path.dirname(workflowFile), { recursive: true });
  fs.writeFileSync(workflowFile, YAML.stringify(workflow));

  const workflowProcess = child_process.spawn("gh", [
    "act",
    "--workflows", workflowFile,
    "--platform", "host=-self-hosted",
    "--action-offline-mode",
    "--actor", github.context.actor,
    "-s", `GITHUB_TOKEN=${githubToken}`,
    // "--env-file", envFilePath,
    // "--eventpath", eventFilePath
    "--bind", // do not copy working directory files
    "--log-prefix-job-id",
    "--json",
  ], { env: process.env });

  const jobResults = Object.fromEntries(Object.keys(workflow.jobs).map(jobId => [jobId, {
    startTime: null,
    endTime: null,
    get executionTime() {
      return this.endTime - this.startTime;
    },
    status: null,
    output: "",
  }]));

  console.log('');
  core.startGroup("Output");

  readline.createInterface({input: workflowProcess.stdout, crlfDelay: Infinity})
    .on('line', newOutputLineHandler(workflowProcess.stdout, jobResults));
  readline.createInterface({input: workflowProcess.stderr, crlfDelay: Infinity})
    .on('line', newOutputLineHandler(workflowProcess.stderr, jobResults));

  workflowProcess.on("exit", () => {
    core.endGroup(); // "Output"

    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      console.log('');
      logStep(jobId, job, jobResults[jobId]);
      // export step command files
      GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES.forEach((varName) => {
          const commandFileContent = fs.readFileSync(`${commandFilesDir}/${jobId}+${varName}`, 'utf8');
          const commandFileName = process.env[varName];
          fs.appendFileSync(commandFileName, commandFileContent);
      })
    }
  });

  await childProcessClosed(workflowProcess);

  function newOutputLineHandler(outputStream, jobResults) {
    return (line) => {
      try {
        line = JSON.parse(line);
      } catch (error) {
        return;
      }

      if(!line.jobID) {
        return;
      }

      const jobResult = jobResults[line.jobID];
      if(!jobResult.startTime) {
        jobResult.startTime = new Date();
        console.log(buildStepHeadline(line.jobID, workflow.jobs[line.jobID]));
      }

      if(line.stage === "Pre" || line.stage === "Post") {
        if(line.level === 'info' || line.level === 'warn' || line.level === 'error') {
          const msg = adjustMessage(line.msg);
          console.log(`[${line.jobID}] [${line.stage}] ${msg}`);
          jobResult.output += `[${line.stage}] ${ensureNewline(msg)}`;
        }
      } else if(line.stage === "Main") {
        if(line.raw_output) {
          process.stdout.write(`[${line.jobID}] ${ensureNewline(line.msg)}`);
          jobResult.output += `${line.msg}`;
        }
      } else if (line.jobResult) {
        jobResult.endTime = new Date();
        jobResult.status = line.jobResult;
        console.log(buildStepHeadline(line.jobID, workflow.jobs[line.jobID], jobResult));
      }
    }
  }
}

function adjustMessage(msg) {
  return msg.replace(/^ {2}☁\s+/, '');
}

function logStep(jobId, job, jobResult) {
  core.startGroup(' ' + buildStepHeadline(jobId, job, jobResult));

  const step = job.steps.at(-1);
  const stepConfigPadding = '  ';

  if(step.run) {
    console.log(leftPad(stepConfigPadding,
      colorizeCyan(step.run.replace(/\n$/, '')),
    ));
  }
  const stepConfiguration = {...step};
  delete stepConfiguration.name;
  delete stepConfiguration.run;
  delete stepConfiguration.uses;

  if(Object.keys(stepConfiguration).length) {
    console.log(leftPad(stepConfigPadding,
      YAML.stringify(stepConfiguration).replace(/\n$/, ''),
    ));
  }

  if (jobResult) {
    console.log(jobResult.output.replace(/\n$/, ''));
  }

  core.endGroup();
}

function buildStepHeadline(jobId, job, jobResult) {
  let groupHeadline = '';
  if(jobResult){
    groupHeadline += (jobResult.status === 'success' ? '⚪️' : '🔴') + ' ';
  } else {
    groupHeadline += '▶️ '; // ➤
  }

  const step = job.steps.at(-1);
  groupHeadline += `[${jobId}] Run ${buildStepDisplayName(step)}`;

  if(jobResult?.executionTime) {
    groupHeadline +=` [${formatMilliseconds(jobResult.executionTime)}]`
  }

  return groupHeadline;
}

function buildStepDisplayName(step) {
  let displayName = step.name
  if(!displayName){
    if(step.uses) {
      displayName = step.uses;
    } else {
      displayName = step.run.split('\n')[0].slice(0, 80);
    }
  }
  return displayName;
}

function ensureNewline(text) {
  return text.endsWith('\n') ? text : text + '\n';
}

function leftPad(pad, text) {
  return pad + text.split('\n').join('\n' + pad);
}

function colorizeCyan(value){
  return value.split("\n")
    .map((line) => `\x1b[1;36m${line}\x1b[0m`)
    .join('\n');
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
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  if (parts.length) {
    return parts.join(" ");
  }

  return `${milliseconds}ms`;
}

async function childProcessClosed(childProcess){
  return new Promise((resolve, reject) => {
    // close vs exit => https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
    childProcess.on("close", (exitCode) => {
      if (exitCode !== 0) reject()
      else resolve();
    });
  })
}
