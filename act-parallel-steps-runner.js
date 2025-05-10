import child_process from "node:child_process";
import github from "@actions/github";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import readline from "node:readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEBUG = true;

const GITHUB_TOKEN = process.env["GITHUB_TOKEN"];
const GITHUB_EVENT_PATH = process.env["GITHUB_EVENT_PATH"];
const GITHUB_ACTOR = github.context.actor;
const WORKING_DIRECTORY = process.cwd();
const GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES = [
    // TODO
    // "GITHUB_OUTPUT",
    // "GITHUB_ENV",
    // "GITHUB_PATH",
    // "GITHUB_STEP_SUMMARY",
].map((varName) => [varName, process.env[varName]]);

const STEPS = YAML.parse(process.argv[2]);

const tempDir = process.cwd(); // TODO `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
fs.mkdirSync(tempDir, {recursive: true});

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
                        with: {
                            'stage': 'main-end',
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

const actOutputFile = path.join(tempDir, "act-parallel-steps-output");
console.log(`Act output file: ${actOutputFile}`);
// child_process.spawnSync("mkfifo", [actOutputFile]);

// let actOutputFileStream = fs.createWriteStream(actOutputFile)
// actOutputFileStream.on('error', (err) => {
//     if (err.code === 'EPIPE') {
//         console.error('Broken pipe error detected. The reading end might have closed.');
//     } else {
//         throw err;
//     }
// });

const actJobResults = Object.fromEntries(Object.keys(workflow.jobs)
    .map(jobId => [jobId, {
        startTime: null,
        endTime: null,
        get executionTime() {
            return this.endTime && this.startTime
                ? this.endTime - this.startTime
                : null;
        },
        status: null,
        commandFiles: Object.fromEntries(GITHUB_COMMAND_FILE_ENVIRONMENT_VARIABLES
            .map(([varName]) => [varName, ''])),
    }]));

readline.createInterface({input: actProcess.stdout, crlfDelay: Infinity})
    .on('line', lineHandler);
readline.createInterface({input: actProcess.stderr, crlfDelay: Infinity})
    .on('line', lineHandler);

function lineHandler(line) {
    if (!line) return;
    line = parseActLine(line);
    line.msg = removeTrailingNewLine(line.msg);
    // normalize level to github core log levels
    if (line.level === 'warn') line.level = 'warning';

    if (line.msg.endsWith("not located inside a git repository")
        || line.msg.endsWith("unable to get git ref: repository does not exist")
        || line.msg.endsWith("unable to get git revision: repository does not exist")) {
        return;
    }

    if (line.jobID) {
        const jobResult = actJobResults[line.jobID];
        // step job start
        if (!jobResult.startTime) {
            jobResult.startTime = new Date();

            const msg = getJobStatusPrefix(jobResult.status) + getJobIdIndicator(line.jobID)
                + buildStepHeadline(workflow.jobs[line.jobID]);
            DEBUG && console.log(msg);
            fs.appendFileSync(actOutputFile, JSON.stringify({jobID: line.jobID, msg}) + '\n');
        }
        // step job end
        if (!line.jobResult) {
            if (line.raw_output) {
                if(line.msg.startsWith('__::act-interceptor::')) {
                    const lineMatch = line.msg.match(/::(?<stage>[^:]+)-(?<status>[^-]+)$/);
                    line.stage = lineMatch.groups.stage;
                }
                const msg = '   ' + getJobIdIndicator(line.jobID)
                    + (line.stage !== 'Main' ? colorizeGray(`[${line.stage}] `) : '')
                    + line.msg;
                DEBUG && console.log(msg);
                fs.appendFileSync(actOutputFile, JSON.stringify({jobID: line.jobID, msg}) + '\n');
            };
        } else {
            jobResult.endTime = new Date();
            jobResult.status = line.jobResult;
            const msg = getJobStatusPrefix(jobResult.status) + getJobIdIndicator(line.jobID)
                + buildStepHeadline(workflow.jobs[line.jobID], jobResult);
            DEBUG && console.log(msg);
            fs.appendFileSync(actOutputFile, JSON.stringify({jobID: line.jobID, msg}) + '\n');
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
};

// --- Utility functions ---

function parseActLine(line) {
    try {
        return JSON.parse(line);
    } catch (error) {
        {
            const lineMatch = line.match(/^level=(?<level>[\w-]+)\smsg=(?<msg>.*)/);
            if (lineMatch) {
                let level = lineMatch.groups.level;
                return {
                    level, msg:
                    lineMatch.groups.msg,
                };
            }
        }

        {
            const lineMatch = line.match(/^Error: (?<msg>.*)/);
            if (lineMatch) {
                const msgMatch = lineMatch.groups.msg.match(/(?<msg>.*)for job:(?<jobID>\w+) step:(?<step>\d+)$/);
                if (msgMatch) {
                    return {
                        level: 'error',
                        msg: msgMatch.groups.msg,
                        jobID: msgMatch.groups.jobID,
                        step: [msgMatch.groups.step],
                    };
                }

                return {
                    level: 'error',
                    msg: lineMatch.groups.msg,
                };
            }
        }

        return {
            level: 'error',
            msg: line,
        };
    }
}

function extendBasename(filePath, annex) {
    const pathSplit = filePath.split('/');
    pathSplit.push(pathSplit.pop().replace(/^([^.]+)/, '$1' + annex));
    return pathSplit.join('/');
}

function ensureNewLine(text) {
    return text.endsWith('\n') ? text : text + '\n';
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

function getJobStatusPrefix(status) {
    if (status) {
        return status === 'success'
            ? colorizeGray('⬤ ')
            : colorizeRed('⬤ ');
    }
    return colorizeGray('❯  ');
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

function getJobStep(job) {
    return job.steps.at(-2);
}
