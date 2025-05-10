import core from '@actions/core';
import YAML from 'yaml';
import child_process from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import TailFile from '@logdna/tail-file';
import {untilFilePresent} from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- send the main stage signal to act-interceptor
// TODO better file location
fs.writeFileSync(process.cwd() + '/.pre-step', '');

const WORKING_DIRECTORY = process.cwd();
const GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES = [
    "GITHUB_OUTPUT",
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
].map((varName) => [varName, process.env[varName]]);
// TODO ensure no undefined variables

const githubToken = core.getInput("token", {required: true});
// Get steps from input
const steps = YAML.parse(core.getInput("steps", {required: true}));

if (!Array.isArray(steps)) {
    throw new Error("steps must be an array");
}

// Install gh-act extension
child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
    stdio: 'inherit',
    env: {...process.env, GH_TOKEN: githubToken}
});


const actRunnerProcess = child_process.spawn(process.execPath, [
    path.join(__dirname, 'act-parallel-steps-runner.js'),
    YAML.stringify(steps),
], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {...process.env, GH_TOKEN: githubToken},
    detached: true,
})
actRunnerProcess.unref();


// --------------------

const stage = 'pre';
console.log(`__::${stage}::`);
// --- send the main stage signal to act-interceptor
// TODO better file location
fs.writeFileSync(process.cwd() + `/.${stage}-step`, '');

const tempDir = process.cwd(); // TODO `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
fs.mkdirSync(tempDir, {recursive: true});

const actOutputFilePath = path.join(tempDir, "act-parallel-steps-output");
await untilFilePresent(actOutputFilePath);
console.log(`Act output file: ${actOutputFilePath}`);

const actOutputTailStream = new TailFile(actOutputFilePath)
    .on('tail_error', (err) => console.error(err));

core.startGroup("Concurrent Logs");

await actOutputTailStream.start();
readline.createInterface({
    input: actOutputTailStream,
    crlfDelay: Infinity,
}).on('line', async (line) => {
    line = JSON.parse(line);
    // TODO wait for all stage steps to finish
    if (line.msg.endsWith(`__::act-interceptor::${stage}-end::`)) {
        console.log(line.msg);
        core.endGroup();

        // destroy all act process stdio streams to be able to finish the pre step stage
        // actRunnerProcess.stdio.forEach((stdio => stdio.destroy()))
        // actOutputTailStream.destroy();
        // TODO exit gracefully
        process.exit(0);
    } else {
        console.log(line.msg);
    }
});

function adjustMessage(msg) {
    return msg.replace(/^ {2}☁\s+/, '');
}

function logStep(jobId, job, jobResult) {
    core.startGroup(' ' + buildStepHeadline(jobId, job, jobResult, {noJobId: true}));

    const stepConfigPadding = '  ';

    const step = getJobStepId(job);
    if (step.run) {
        console.log(leftPad(stepConfigPadding,
            colorizeCyan(step.run.replace(/\n$/, '')),
        ));
    }
    const stepConfiguration = {...step};
    delete stepConfiguration.name;
    delete stepConfiguration.run;
    delete stepConfiguration.uses;

    if (Object.keys(stepConfiguration).length) {
        console.log(leftPad(stepConfigPadding, removeTrailingNewline(YAML.stringify(stepConfiguration))));
    }

    if (jobResult) {
        console.log(removeTrailingNewline(jobResult.output));
    }

    core.endGroup();
}

function buildStepHeadline(jobId, job, jobResult = null, options = {}) {
    let groupHeadline = '';
    if (jobResult) {
        groupHeadline += jobResult.status === 'success'
            ? colorizeGray('⬤ ')
            : colorizeRed('⬤ ');
    } else {
        groupHeadline += colorizeGray('❯  ');
    }


    if (!options.noJobId) {
        groupHeadline += colorizeGray(`[${getJobIdDisplayName(jobId)}] `);
    }
    const step = getJobStepId(job);
    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (jobResult?.executionTime) {
        groupHeadline += colorizeGray(` [${formatMilliseconds(jobResult.executionTime)}]`);
    }

    return groupHeadline;
}

function buildStepDisplayName(step) {
    let displayName = 'INVALID STEP';

    if (step.name) {
        displayName = step.name;
    } else if (step.uses) {
        displayName = step.uses;
    } else if (step.run) {
        displayName = step.run.split('\n')[0];
    }

    return displayName;
}

function getJobIdDisplayName(jobId) {
    return jobId.replace(/^Step_/, 'Step ');
}

function ensureNewline(text) {
    return text.endsWith('\n') ? text : text + '\n';
}

function removeTrailingNewline(text) {
    return text.replace(/\n$/, '');
}

function leftPad(pad, text) {
    return pad + text.split('\n').join('\n' + pad);
}

function colorizeCyan(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;36m${line}\x1b[0m`)
        .join('\n');
}

function colorizeGray(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;90m${line}\x1b[0m`)
        .join('\n');
}

function colorizeRed(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;31m${line}\x1b[0m`)
        .join('\n');
}

function colorizeYellow(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;33m${line}\x1b[0m`)
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

function formatLogLevel(level) {
    let formattedLevel = String(level).charAt(0).toUpperCase() + String(level).slice(1);
    if (formattedLevel === 'Warning') {
        formattedLevel = colorizeYellow(formattedLevel);
    } else if (formattedLevel === 'Error') {
        formattedLevel = colorizeRed(formattedLevel);
    }
    return formattedLevel;
}

function getJobStepId(job) {
    return job.steps.at(-1);
}
