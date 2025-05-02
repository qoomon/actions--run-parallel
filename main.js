import core, {ExitCode} from '@actions/core';
import github from '@actions/github';
import YAML from 'yaml';
import child_process from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const WORKING_DIRECTORY = process.cwd();
const GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES = [
    "GITHUB_OUTPUT",
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_STEP_SUMMARY",
];

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

await runStepsInParallel(steps).catch((error) => {
    console.log('')
    if (core.isDebug()) {
        console.error(error.stack);
    }
    process.exitCode = ExitCode.Failure;
});

// ----------------------------------------------------------------

async function runStepsInParallel(steps) {
    const actionTempDir = `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
    fs.mkdirSync(actionTempDir, {recursive: true});

    const workflowFile = `${actionTempDir}/parallel-steps.yaml`;
    const workflow = {
        on: "workflow_dispatch",
        jobs: Object.assign({}, ...steps
            .map((step, index) => [`Step_${index}`, step])
            .map(([jobId, step]) => ({
                [jobId]: {
                    "runs-on": "host",
                    "steps": [
                        {
                            name: "Link job working directory to host working directory",
                            run: [
                                'rm -rf "$PWD"',
                                `ln -s '${WORKING_DIRECTORY}' "$PWD"`,
                            ].join('\n'),
                        },
                        {
                            name: "Link job command files to temp host files",
                            run: GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES.map((varName) => [
                                `rm -f "$${varName}"`,
                                `ln -s '${actionTempDir}/${jobId}+${varName}' "$${varName}"`,
                            ]).flat().join('\n'),
                        },
                        step,
                    ]
                }
            }))
        )
    };
    fs.writeFileSync(workflowFile, YAML.stringify(workflow));

    const workflowProcess = child_process.spawn("gh", [
        "act",
        "--workflows", workflowFile,
        "--platform", "host=-self-hosted",
        "--action-offline-mode",
        "--actor", github.context.actor,
        "-s", `GITHUB_TOKEN=${githubToken}`,
        "--eventpath", process.env["GITHUB_EVENT_PATH"],
        "--bind", // do not copy working directory files
        "--log-prefix-job-id",
        "--json",
    ], {env: {...process.env, GH_TOKEN: githubToken}});

    const workflowProcessResults = {
        output: "",
        jobs: Object.fromEntries(Object.keys(workflow.jobs).map(jobId => [jobId, {
            startTime: null,
            endTime: null,
            get executionTime() {
                return this.endTime && this.startTime
                    ? this.endTime - this.startTime
                    : null;
            },
            status: null,
            output: "",
        }])),
    }

    core.startGroup("Concurrent Logs");

    readline.createInterface({input: workflowProcess.stdout, crlfDelay: Infinity})
        .on('line', newOutputLineHandler(workflowProcess.stdout, workflowProcessResults));
    readline.createInterface({input: workflowProcess.stderr, crlfDelay: Infinity})
        .on('line', newOutputLineHandler(workflowProcess.stderr, workflowProcessResults));

    await childProcessClosed(workflowProcess).finally(() => {
        core.endGroup(); // "Output"

        if (workflowProcessResults.output) {
            console.log('');
            console.log(removeTrailingNewline(workflowProcessResults.output));
        }

        for (const [jobId, job] of Object.entries(workflow.jobs)) {
            console.log('');
            logStep(jobId, job, workflowProcessResults.jobs[jobId]);
            const step = job.steps.at(-1);
            // export step command files
            GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES.forEach((varName) => {
                if (fs.existsSync(`${actionTempDir}/${jobId}+${varName}`)) {
                    let commandFileContent = fs.readFileSync(`${actionTempDir}/${jobId}+${varName}`, 'utf8');
                    if (varName === 'GITHUB_OUTPUT' && step.id) {
                        // prefix outputs with the step id
                        commandFileContent = commandFileContent
                            .replaceAll(/^(?<name>[\w-]+)(?=<<ghadelimiter_)/gm, `${step.id}-$1`);
                    }
                    const commandFileName = process.env[varName];
                    fs.appendFileSync(commandFileName, commandFileContent);
                }
            })
        }
    });

    function newOutputLineHandler(outputStream, workflowProcessResults) {
        return (line) => {
            if (!line) return;
            try {
                line = JSON.parse(line);
            } catch (error) {
                const lineMatch = line.match(/^level=(?<level>[\w-]+)\smsg=(?<msg>.*)/);
                if (lineMatch) {
                    let level = lineMatch.groups.level;
                    line = {level, msg: lineMatch.groups.msg}
                } else {
                    const lineMatch = line.match(/^Error: (?<msg>.*)/);
                    if (lineMatch) {
                        const msgMatch = lineMatch.groups.msg.match(/(?<msg>.*)for job:(?<jobID>\w+) step:(?<step>\d+)$/);
                        if (msgMatch) {
                            line = {
                                level: 'error',
                                msg: msgMatch.groups.msg,
                                jobID: msgMatch.groups.jobID,
                                step: [msgMatch.groups.step],
                            };
                        } else {
                            line = {
                                level: 'error',
                                msg: lineMatch.groups.msg,
                            };
                        }
                    } else {
                        line = {
                            level: 'error',
                            msg: line,
                        };
                    }
                }
            }
            // normalize level to github core log levels
            if (line.level === 'warn') line.level = 'warning';

            if (line.msg.endsWith("not located inside a git repository")
                || line.msg.endsWith("unable to get git ref: repository does not exist")
                || line.msg.endsWith("unable to get git revision: repository does not exist")) {
                return;
            }

            if (line.jobID) {
                const jobResult = workflowProcessResults.jobs[line.jobID];
                // step job start
                if (!jobResult.startTime) {
                    jobResult.startTime = new Date();
                    core.info(buildStepHeadline(line.jobID, workflow.jobs[line.jobID]));
                }
                // step job end
                if (line.jobResult) {
                    jobResult.endTime = new Date();
                    jobResult.status = line.jobResult;
                    core.info(buildStepHeadline(line.jobID, workflow.jobs[line.jobID], jobResult));
                } else if (line.stage === "Main" && line.raw_output) {
                    jobResult.output += ensureNewline(line.msg);

                    const logPrefix = colorizeGray(`   [${getJobIdDisplayName(line.jobID)}] `);
                    console.log(logPrefix + removeTrailingNewline(line.msg));
                } else if (line.stage === "Pre" || line.stage === "Post") {
                    if (!line.stepResult) {
                        const msg = adjustMessage(line.msg);

                        let outputPrefix = colorizeGray(`  [${line.stage}] `);
                        if (line.level !== 'info') {
                            outputPrefix += `${formatLogLevel(line.level)}: `;
                        }
                        jobResult.output += `${formatLogLevel(line.level)}: ` + outputPrefix + ensureNewline(msg);

                        let logPrefix = colorizeGray(`   [${getJobIdDisplayName(line.jobID)}] `) + outputPrefix;
                        console.log(logPrefix + removeTrailingNewline(msg));
                    }
                } else if (line.level === 'error' || line.level === 'warning' || core.isDebug()) {
                    const ignoreLine = line.msg.match(/^exit status /);
                    if (!ignoreLine) {
                        let outputPrefix = ''
                        if (line.level !== 'info') {
                            outputPrefix += `${formatLogLevel(line.level)}: `;
                        }
                        jobResult.output += outputPrefix + ensureNewline(line.msg);

                        const logPrefix = colorizeGray(`   [${getJobIdDisplayName(line.jobID)}] `) + outputPrefix;
                        console.log(logPrefix + removeTrailingNewline(line.msg));
                    }
                }
            } else if (line.level === 'error' || line.level === 'warning' || core.isDebug()) {
                const ignoreLine = line.msg.match(/^Job 'Step_\d+' failed$/)
                if (!ignoreLine) {
                    let outputPrefix = line.stage ? colorizeGray(`[${line.stage}] `) : '';
                    if (line.level !== 'info') {
                        outputPrefix += `${formatLogLevel(line.level)}: `;
                    }
                    workflowProcessResults.output += outputPrefix + ensureNewline(line.msg);

                    const logPrefix = outputPrefix;
                    console.log(logPrefix + removeTrailingNewline(line.msg));
                }
            }
        }
    }
}

function adjustMessage(msg) {
    return msg.replace(/^ {2}☁\s+/, '');
}

function logStep(jobId, job, jobResult) {
    core.startGroup(' ' + buildStepHeadline(jobId, job, jobResult, {noJobId: true}));

    const step = job.steps.at(-1);
    const stepConfigPadding = '  ';

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

function buildStepHeadline(jobId, job, jobResult, options = {}) {
    let groupHeadline = '';
    if (jobResult) {
        groupHeadline += jobResult.status === 'success'
            ? colorizeGray('⬤ ')
            : colorizeRed('⬤ ');
    } else {
        groupHeadline += colorizeGray('❯  ');
    }

    const step = job.steps.at(-1);
    if (!options.noJobId) {
        groupHeadline += colorizeGray(`[${getJobIdDisplayName(jobId)}] `);
    }
    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (jobResult?.executionTime) {
        groupHeadline += colorizeGray(` [${formatMilliseconds(jobResult.executionTime)}]`);
    }

    return groupHeadline;
}

function buildStepDisplayName(step) {
    let displayName = 'INVALID STEP';

    if(step.name) {
        displayName = step.name;
    } else if(step.uses) {
        displayName = step.uses;
    } else if(step.run) {
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

async function childProcessClosed(childProcess) {
    return new Promise((resolve, reject) => {
        // close vs exit => https://stackoverflow.com/questions/37522010/difference-between-childprocess-close-exit-events
        childProcess.on("close", (exitCode) => {
            if (exitCode !== 0) reject(new Error("Process exited with non-zero code: " + exitCode));
            else resolve();
        });
    })
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