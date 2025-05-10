import child_process from "node:child_process";
import github from "@actions/github";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import readline from "node:readline";
import {colorizeGray, colorizeRed, DEBUG, formatMilliseconds, untilFilePresent} from "./act-interceptor/utils.js";
import {EOL} from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const tempDir = process.cwd(); // TODO `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
fs.mkdirSync(tempDir, {recursive: true});
DEBUG && console.log(`Runner temp dir: ${tempDir}`);

// ----------------------------------------------------------------------------

const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
const GITHUB_EVENT_PATH = process.env["GITHUB_EVENT_PATH"];
const GITHUB_ACTOR = process.env["GITHUB_ACTOR"];
const WORKING_DIRECTORY = process.cwd();
const GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES = [
    // TODO
    // "GITHUB_OUTPUT",
    // "GITHUB_ENV",
    // "GITHUB_PATH",
    // "GITHUB_STEP_SUMMARY",
].map((varName) => [varName, process.env[varName]]);

const STEPS = YAML.parse(process.argv[2]);

// ----------------------------------------------------------------------------

const workflow = {
    on: "workflow_dispatch",
    jobs: Object.assign({}, ...STEPS
        .map((step, index) => [`step${index}`, step])
        .map(([jobId, step]) => ({
            [jobId]: {
                "runs-on": "host",
                "steps": [
                    {
                        uses: "__/act-interceptor@local",
                        with: {
                            'temp-dir': tempDir,
                            'host-working-directory': WORKING_DIRECTORY,
                            'command-files': GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES
                                .map(([varName, filePath]) =>
                                    `${varName}=${extendBasename(filePath, `-${jobId}`)}`)
                                .join('\n'),
                        }
                    },
                    step,
                    {
                        uses: "__/act-interceptor@local",
                        if: "always()",
                        with: {
                            'sub-stage': 'Main::After',
                            'temp-dir': tempDir
                        }
                    },
                ]
            }
        }))
    )
};
const workflowFile = path.join(tempDir, 'parallel-steps.yaml');
fs.writeFileSync(workflowFile, YAML.stringify(workflow));

//
// // --- tail job command files for every job
// const commandFileSockets = [];
// for (const jobId of Object.keys(workflow.jobs)) {
//     for (const [varName, filePath] of GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES) {
//         const actJobCommandFilePath = extendBasename(filePath, jobId);
//
//         // TODO use library for mkfifo
//         await childProcessClosed(child_process.spawn("mkfifo", [actJobCommandFilePath]));
//         const commandFile = await fs.open(actJobCommandFilePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
//         const commandFileSocket = new net.Socket({fd: commandFile.fd});
//         // need to store the file along with socket to prevent the file from garbage collection
//         commandFileSockets.push([commandFile, commandFileSocket]);
//         readline.createInterface({input: commandFileSocket, crlfDelay: Infinity})
//             .on('line', (line) => {
//                 workflowProcessResults.jobs[jobId].commandFiles[varName] += line + '\n';
//             })
//     }
// }

// TODO handle invalid steps or log error
const actProcess = child_process.spawn("gh", [
    "act",
    "--action-offline-mode",
    "--bind", // do not copy working directory files
    "--platform", "host=-self-hosted",
    "--local-repository", "__/act-interceptor@local" + "=" + `${__dirname}/act-interceptor`,

    GITHUB_EVENT_PATH ? ["--eventpath", GITHUB_EVENT_PATH] : [],
    "--actor", GITHUB_ACTOR,
    "--secret", `GITHUB_TOKEN=${GITHUB_TOKEN}`,

    "--workflows", workflowFile,

    "--log-prefix-job-id",
    "--json",
].flat(), {env: {...process.env, GH_TOKEN: GITHUB_TOKEN}});

readline.createInterface({input: actProcess.stdout, crlfDelay: Infinity})
    .on('line', lineHandler);
readline.createInterface({input: actProcess.stderr, crlfDelay: Infinity})
    .on('line', lineHandler);

const ACT_STAGES = ['Pre', 'Main', 'Post'];
let actStageIndex = 0;
let actStage = ACT_STAGES[0];
let actJobResults = newActJobResults();
await untilFilePresent(path.join(tempDir, `.Runner-${actStage}-Stage`));
let actOutputFile = path.join(tempDir, `.Runner-${actStage}-Stage-Output`);
// TODO core.startGroup()
logOutput(`__::Runner::${actStage}::Start::`);
// --- create the trigger file to signal act-interceptor to start the next stage
fs.writeFileSync(path.join(tempDir, `.Interceptor-${actStage}-Stage`), '');

function newActJobResults() {
    return Object.fromEntries(Object.keys(workflow.jobs)
        .map(jobId => [jobId, {
            startTime: null,
            endTime: null,
            get executionTime() {
                return this.endTime && this.startTime
                    ? this.endTime - this.startTime
                    : null;
            },
            output: '',
            status: null,
            commandFiles: Object.fromEntries(GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES
                .map(([varName]) => [varName, ''])),
        }]));
}

async function lineHandler(line) {
    if (!line) return;

    line = parseActLine(line);


    if (line.msg.endsWith("not located inside a git repository")
        || line.msg.endsWith("unable to get git ref: repository does not exist")
        || line.msg.endsWith("unable to get git revision: repository does not exist")) {
        return;
    }

    if (line.jobID) {
        const jobResult = actJobResults[line.jobID] ??= {};
        if (line.raw_output) {
            // TODO if(line.executionTime && line.stepID[0] !== '1') {

            const interceptorEvent = line.msg.match(/^__::Interceptor::(?<stage>[^:]+)::(?<type>[^:]+)::(?<value>[^:]*)?/)?.groups;
            if (interceptorEvent) {
                // TODO
                // if (interceptorEvent.stage !== actStage) {
                //     throw Error("Unexpected stage: " + line.msg);
                // }

                line.stage = interceptorEvent.stage;
                if (interceptorEvent.type === 'Start') {
                    jobResult.startTime = new Date();

                    const msg = getJobStatusPrefix() + getJobIdIndicator(line.jobID)
                        + buildStepHeadline(workflow.jobs[line.jobID]);
                    logOutput(msg);
                } else if (interceptorEvent.type === 'End') {
                    jobResult.endTime = new Date();
                    // TODO jobResult not available for interceptor message
                    // add job status to interceptor event
                    // jobResult.status = line.jobResult;
                    const msg = getJobStatusPrefix(jobResult.status) + getJobIdIndicator(line.jobID)
                        + buildStepHeadline(workflow.jobs[line.jobID], jobResult);
                    logOutput(msg);

                    if (Object.values(actJobResults).every((result) => result.endTime)) {
                        logOutput(`__::Runner::${actStage}::End::`);
                        // TODO core.endGroup();

                        if (actStageIndex === ACT_STAGES.length - 1) {
                            process.exit(0);
                        }

                        // TODO export to function
                        actStageIndex++;
                        actStage = ACT_STAGES[actStageIndex];
                        actJobResults = newActJobResults();
                        await untilFilePresent(path.join(tempDir, `.Runner-${actStage}-Stage`));
                        actOutputFile = path.join(tempDir, `.Runner-${actStage}-Stage-Output`);
                        // TODO core.startGroup()
                        logOutput(`__::Runner::${actStage}::Start::`);
                        // --- create the trigger file to signal act-interceptor to start the next stage
                        fs.writeFileSync(path.join(tempDir, `.Interceptor-${actStage}-Stage`), '');
                    }
                }
                return;
            }
            const msg = '   ' + getJobIdIndicator(line.jobID)
                + (line.stage !== 'Main' ? colorizeGray(`[${line.stage}] `) : '')
                + line.msg;
            logOutput(msg);
            jobResult.output += msg + EOL;
        }

        // else if (line.stage === "Pre" || line.stage === "Post") {
        //     if (!line.stepResult && line.raw_output) {
        //         const msg = adjustMessage(line.msg);
        //
        //         let outputPrefix = colorizeGray(`[${line.stage}] `);
        //         if (line.level !== 'info') {
        //             outputPrefix += `${formatLogLevel(line.level)}: `;
        //         }
        //         jobResult.output += outputPrefix + ensureNewline(msg);
        //
        //         let logPrefix = colorizeGray(`   [${getJobIdDisplayName(line.jobID)}] `) + outputPrefix;
        //         console.log(logPrefix + removeTrailingNewline(msg));
        //     }
        // } else if (line.level === 'error' || line.level === 'warning' || core.isDebug()) {
        //     const ignoreLine = line.msg.match(/^exit status /);
        //     if (!ignoreLine) {
        //         let outputPrefix = ''
        //         if (line.level !== 'info') {
        //             outputPrefix += `${formatLogLevel(line.level)}: `;
        //         }
        //         jobResult.output += outputPrefix + ensureNewline(line.msg);
        //
        //         const logPrefix = colorizeGray(`   [${getJobIdDisplayName(line.jobID)}] `) + outputPrefix;
        //         console.log(logPrefix + removeTrailingNewline(line.msg));
        //     }
        // }
    }
    // else if (line.level === 'error' || line.level === 'warning' || core.isDebug()) {
    //     const ignoreLine = line.msg.match(/^Job 'Step_\d+' failed$/)
    //     if (!ignoreLine) {
    //         let outputPrefix = line.stage ? colorizeGray(`[${line.stage}] `) : '';
    //         if (line.level !== 'info') {
    //             outputPrefix += `${formatLogLevel(line.level)}: `;
    //         }
    //         workflowProcessResults.output += outputPrefix + ensureNewline(line.msg);
    //
    //         const logPrefix = outputPrefix;
    //         console.log(logPrefix + removeTrailingNewline(line.msg));
    //     }
    // }

    // if (workflowProcessResults.output) {
    //     console.log('');
    //     console.log(removeTrailingNewline(workflowProcessResults.output));
    // }
    //
    // for (const [jobId, job] of Object.entries(workflow.jobs)) {
    //     console.log('');
    //     logStep(jobId, job, workflowProcessResults.jobs[jobId]);
    //
    //     const step = getJobStepId(job);
    //
    //     for (const [varName, commandFile] of GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES) {
    //         let commandFileContent = workflowProcessResults.jobs[jobId].commandFiles[varName];
    //         if (varName === 'GITHUB_OUTPUT' && step.id) {
    //             // prefix outputs with the step id
    //             commandFileContent = commandFileContent
    //                 .replaceAll(/^(?<name>[\w-]+)(?=<<ghadelimiter_)/gm, `${step.id}-$1`);
    //         }
    //         await fs.appendFile(commandFile, commandFileContent);
    //     }
    // }
}

// --- Utility functions ---
function logOutput(message) {
    console.log(message);

    fs.appendFileSync(actOutputFile, message + EOL);
}

function parseActLine(line) {
    let result = {
        level: 'error',
        msg: line,
    };

    try {
        result = JSON.parse(line);
    } catch (error) {
        const lineMatch = line.match(/^level=(?<level>[\w-]+)\smsg=(?<msg>.*)/);
        if (lineMatch) {
            result = {
                level: lineMatch.groups.level,
                msg: lineMatch.groups.msg,
            };
        } else {
            const lineMatch = line.match(/^Error: (?<msg>.*)/);
            if (lineMatch) {
                result = {
                    level: 'error',
                    msg: lineMatch.groups.msg,
                };

                const msgMatch = lineMatch.groups.msg.match(/(?<msg>.*)for job:(?<jobID>\w+) step:(?<step>\d+)$/);
                if (msgMatch) {
                    result = {
                        level: 'error',
                        msg: msgMatch.groups.msg,
                        jobID: msgMatch.groups.jobID,
                        step: [msgMatch.groups.step],
                    };
                }
            }
        }
    }

    result.msg = result.msg.trimEnd();

    // normalize level to github core log levels
    if (result.level === 'warn') result.level = 'warning';

    return result;
}

function removeTrailingNewLine(text) {
    return text.replace(/\n$/, '');
}

function buildStepHeadline(job, jobResult = null) {
    let groupHeadline = '';

    const step = getJobStep(job);
    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (jobResult?.executionTime) {
        groupHeadline += colorizeGray(` [${formatMilliseconds(jobResult.executionTime)}]`);
    }

    return groupHeadline;
}

function getJobIdIndicator(jobId) {
    return colorizeGray(`[${getJobIdDisplayName(jobId)}] `);
}

function getJobStatusPrefix(status = null) {
    if (!status) {
        return colorizeGray('❯  ');
    }

    return status === 'success'
        ? colorizeGray('⬤ ')
        : colorizeRed('⬤ ');
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
    return jobId.replace(/^step\s*/i, 'Step ');
}

// TODO refactor
function getJobStep(job) {
    return job.steps.at(-2);
}
