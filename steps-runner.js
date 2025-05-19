import child_process from "node:child_process";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import readline from "node:readline";
import {
    ACTION_TEMP_DIR,
    colorizeCyan,
    colorizeGray,
    colorizeRed,
    DEBUG,
    TRACE,
    untilFilePresent
} from "./act-interceptor/utils.js";
import core from "@actions/core";
import {EOL} from "node:os";
import TailFile from "@logdna/tail-file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const stepsFilePath = path.join(ACTION_TEMP_DIR, 'steps.yaml');
const actLogPath = path.join(ACTION_TEMP_DIR, 'act.log');

export async function init(steps, githubToken) {
    const GITHUB_EVENT_PATH = process.env["GITHUB_EVENT_PATH"];
    const GITHUB_ACTOR = process.env["GITHUB_ACTOR"];
    const WORKING_DIRECTORY = process.cwd();

    fs.writeFileSync(stepsFilePath, YAML.stringify(steps));
    const workflow = {
        on: "workflow_dispatch",
        jobs: {},
    }
    for (const [stepIndex, step] of Object.entries(steps)) {
        const jobId = `Step${stepIndex}`

        workflow.jobs[jobId] = {
            "runs-on": "host", // refers to gh act parameter "--platform", "host=-self-hosted",
            "steps": [
                {
                    uses: "__/act-interceptor@local",
                    with: {
                        'temp-dir': ACTION_TEMP_DIR,
                        'host-working-directory': WORKING_DIRECTORY,
                    }
                },
                step,
                {
                    if: "always()",
                    uses: "__/act-interceptor@local",
                    with: {
                        'position': 'Main::End',
                        'temp-dir': ACTION_TEMP_DIR,
                    }
                },
            ],
        };
    }

    const workflowFilePath = path.join(ACTION_TEMP_DIR, 'steps-workflow.yaml'); // TODO [Multi Act Runner]
    fs.writeFileSync(workflowFilePath, YAML.stringify(workflow));

    const actLogFile = fs.openSync(actLogPath, 'w');
    //TODO [Multi Act Runner]
    child_process.spawn(
        "gh", ["act", "--workflows", workflowFilePath,
            "--bind", // do not copy working directory files
            "--platform", "host=-self-hosted",
            "--local-repository", "__/act-interceptor@local" + "=" + `${__dirname}/act-interceptor`,
            "--secret", `GITHUB_TOKEN=${githubToken}`,
            GITHUB_EVENT_PATH ? ["--eventpath", GITHUB_EVENT_PATH] : [],
            GITHUB_ACTOR ? ["--actor", GITHUB_ACTOR] : [],

            "--action-offline-mode",
            "--json",
        ].flat(),
        {
            detached: true,
            stdio: ['ignore', actLogFile, actLogFile],
            env: {...process.env, GH_TOKEN: githubToken},
        }
    ).unref();

    await untilFilePresent(actLogPath); // TODO check if this is still needed
}

export async function run(stage) {
    const steps = YAML.parse(fs.readFileSync(stepsFilePath).toString());
    const stepResults = steps.map(() => ({
        status: 'Queued',
        output: '',
        result: null,
        executionTime: null,
        commandFiles: {
            'GITHUB_OUTPUT': {},
            'GITHUB_ENV': {},
            'GITHUB_PATH': [],
            'GITHUB_STEP_SUMMARY': '',
        },
    }));

    // --- tail act log file
    const actLogTail = new TailFile(actLogPath);
    await actLogTail.start();
    readline.createInterface({input: actLogTail, crlfDelay: Infinity})
        .on('line', async (line) => {
                TRACE && console.log(colorizeCyan(line));
                if (!line) return;
                line = parseActLine(line);

                if (!line.jobID) return;
                const stepIndex = parseInt(line.jobID.replace(/^\D*/, ''));
                const step = steps[stepIndex];
                const stepResult = stepResults[stepIndex];
                if (!stepResult) throw Error(`Unexpected step index: ${stepIndex}`);

                // actual step lines
                if (line.stepID?.[0] === String(1)) {
                    if (!line.raw_output) {
                        if (line.msg.startsWith(`⭐ Run ${stage} `)) {
                            DEBUG && console.log(`__::Step::Start::${stepIndex}`);
                            console.log(
                                buildStepLogPrefix('Start') +
                                buildStepIndicator(stepIndex) +
                                buildStepHeadline(stage, step),
                            );
                        } else if (line.msg.startsWith('  ⚙  ::')) {
                            // command files
                            const command = line.msg.match(/^ {2}⚙ {2}::(?<type>[^:]+):: (?<parameter>.*)$/)?.groups;
                            switch (command.type) {
                                case 'set-output':
                                    const outputCommand = command.parameter.match(/^(?<name>[^=]+)=(?<value>.*)/)?.groups;
                                    if (!outputCommand) {
                                        throw new Error(`Unexpected set-output command: ${line.msg}`);
                                    }
                                    stepResult.commandFiles['GITHUB_OUTPUT'][outputCommand.name] = outputCommand.value;
                                    break;
                                case 'set-env':
                                    const envCommand = command.parameter.match(/^(?<name>[^=]+)=(?<value>.*)/)?.groups;
                                    if (!envCommand) {
                                        throw new Error(`Unexpected set-env command: ${line.msg}`);
                                    }
                                    stepResult.commandFiles['GITHUB_ENV'][envCommand.name] = envCommand.value;
                                    break;
                                case 'add-path':
                                    stepResult.commandFiles['GITHUB_PATH'].push(command.parameter);
                                    break;
                                default:
                                    core.warning('Unexpected command: ' + line.msg);
                            }
                        } else if (line.stepResult) {
                            stepResult.result = line.stepResult;
                            stepResult.executionTime = line.executionTime;
                            console.log(
                                buildStepLogPrefix('End', stepResult.result) +
                                buildStepIndicator(stepIndex) +
                                buildStepHeadline(stage, step, stepResult),
                            );
                            DEBUG && console.log(`__::Step::End::${stepIndex}`)
                        }
                    } else {
                        console.log(
                            buildStepLogPrefix() +
                            buildStepIndicator(stepIndex) +
                            line.msg,
                        );
                        stepResult.output += line.msg + EOL;
                    }
                } else if (line.raw_output) {
                    const interceptorEvent = line.msg.match(/^__::Interceptor::(?<stage>[^:]+)::(?<type>[^:]+)::(?<value>[^:]*)?/)?.groups;
                    if (interceptorEvent) {
                        if (interceptorEvent.stage !== stage) throw Error(`Unexpected stage event: ${line.msg}`);

                        line.stage = interceptorEvent.stage;
                        if (interceptorEvent.type === 'Start') {
                            stepResult.status = 'In Progress';
                        } else if (interceptorEvent.type === 'End') {
                            stepResult.status = 'Completed';

                            // check if the stage has been completed
                            if (Object.values(stepResults).every((result) => result.status === 'Completed')) {
                                core.endGroup()

                                // stop tail processes
                                await actLogTail.quit();

                                steps.forEach((step, stepIndex) => {
                                    const stepResult = stepResults[stepIndex];

                                    // log aggregated step results
                                    if (stepResult.result) {
                                        console.log('')
                                        core.startGroup(' ' +
                                            buildStepLogPrefix('End', stepResult.result) +
                                            buildStepHeadline(stage, step, stepResult)
                                        );
                                        console.log(removeTrailingNewLine(stepResult.output));
                                        core.endGroup();
                                    }

                                    // command files
                                    Object.entries(stepResult.commandFiles['GITHUB_OUTPUT'])
                                        .forEach(([key, value]) => {
                                            DEBUG && console.log(`Set output: ${key}=${value}`);
                                            core.setOutput(key, value);
                                            if (step.id) {
                                                const stepKey = step.id + '-' + key;
                                                DEBUG && console.log(`Set output: ${stepKey}=${value}`);
                                                core.setOutput(stepKey, value);
                                            }
                                        });
                                    Object.entries(stepResult.commandFiles['GITHUB_ENV'])
                                        .forEach(([key, value]) => {
                                            DEBUG && console.log(`Export variable: ${key}=${value}`);
                                            core.exportVariable(key, value);
                                        });
                                    stepResult.commandFiles['GITHUB_PATH']
                                        .forEach((path) => {
                                            DEBUG && console.log(`Add path: ${path}`);
                                            core.addPath(path);
                                        });
                                });

                                DEBUG && console.log(`__::Action::${stage}::End::`);
                            }
                        }
                    } else if (DEBUG) {
                        console.log(line.msg);
                    }
                }
            }
        )
    ;


    DEBUG && console.log(`__::Action::${stage}::Start::`);
    core.startGroup("Concurrent logs"); // TODO lazy start and end if any log occurs
    // --- create the trigger file to signal step runner to start the next stage
    fs.writeFileSync(path.join(ACTION_TEMP_DIR, `.Interceptor-${stage}-Stage`), '');
}

// --- Utility functions ---

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

function buildStepHeadline(actStage, step, jobResult = null) {
    let groupHeadline = '';

    if (actStage !== 'Main') {
        groupHeadline += `${actStage} `;
    }

    groupHeadline += `Run ${buildStepDisplayName(step)}`;

    if (jobResult?.executionTime) {
        groupHeadline += colorizeGray(` [${formatMilliseconds(jobResult.executionTime / 1_000_000)}]`);
    }

    return groupHeadline;
}

function buildStepLogPrefix(event, stepResult) {
    if (event === 'Start') {
        return colorizeGray('❯  ');
    }
    if (event === 'Log' || !event) {
        return colorizeGray('   ');
    }
    if (event === 'End') {
        // no job result indicates the step action has no stage implementation
        if (!stepResult || stepResult === 'success') {
            return colorizeGray('⬤ ');
        }
        return colorizeRed('⬤ ');
    }
}

function buildStepIndicator(stepIndex) {
    return colorizeGray(`[${stepIndex}] `);
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

    parts.push(`${seconds}s`);

    return parts.join(" ");
}