import child_process from "node:child_process";
import fs from "node:fs";
import YAML from "yaml";
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import readline from "node:readline";
import {
    ACTION_STEP_TEMP_DIR,
    colorizeCyan,
    colorizeGray,
    colorizeRed,
    CompletablePromise,
    DEBUG,
    TRACE
} from "./act-interceptor/utils.js";
import core from "@actions/core";
import {EOL} from "node:os";
import TailFile from "@logdna/tail-file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const actLogFilePath = path.join(ACTION_STEP_TEMP_DIR, 'act.log');
const errorStepsFilePath = path.join(ACTION_STEP_TEMP_DIR, '.steps-error');

export async function run(stage) {
    const githubToken = core.getInput("token", {required: true});
    const steps = getInput("steps", {required: true}, (value) => {
        let steps;
        try {
            steps = YAML.parse(value);
        } catch (e) {
            core.setFailed(`Invalid steps input - Invalid YAML - ${e.message}`);
            process.exit(1);
        }

        if (!Array.isArray(steps)) {
            core.setFailed(`Invalid steps input - Must be an YAML array`);
            process.exit(1);
        }

        return steps;
    });

    const stagePromise = new CompletablePromise();
    DEBUG && console.log(`__::Action::${stage}::Start::`);

    if (stage === 'Pre') {
        await startAct(steps, githubToken, actLogFilePath);
        fs.appendFileSync(errorStepsFilePath, ''); // ensure the file does exist
    }

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
    fs.readFileSync(errorStepsFilePath).toString().split('\n').filter((line) => !!line)
        .forEach((stepIndex) => completeStep(stepIndex, 'error'));

    let concurrentLogGroupOpen = false

    function concurrentLog(...args) {
        if (!concurrentLogGroupOpen) {
            core.startGroup("Concurrent logs");
            concurrentLogGroupOpen = true;
        }
        console.log(...args);
    }

    // --- tail act log file
    const actLogTail = new TailFile(actLogFilePath, {startPos: stage === 'Pre' ? 0 : null});
    await actLogTail.start();
    readline.createInterface({input: actLogTail, crlfDelay: Infinity})
        .on('line', async (line) => {
            if (stagePromise.status !== 'pending') return;
            if (!line) return;
            TRACE && concurrentLog(colorizeCyan(line));
            line = parseActLine(line);

            if (line.level === 'error') {
                if (line.msg.startsWith('workflow is not valid.')) {
                    const workflowStepError = line.msg.match(/Failed to match run-step: Line: (?<line>\d+) Column (?<column>\d+): (?<msg>.*)$/)?.groups;
                    stagePromise.reject(new Error(`Invalid steps input - ${workflowStepError?.msg ?? line.msg}`))
                }
            }

            if (!line.jobID) return;
            const stepIndex = parseInt(line.jobID.replace(/^\D*/, ''));
            const step = steps[stepIndex];
            const stepResult = stepResults[stepIndex];
            if (!stepResult) throw Error(`Unexpected step index: ${stepIndex}`);

            // actual step lines
            if (line.stepID?.[0] === String(1)) {
                if (!line.raw_output) {
                    if (line.level === 'error') {
                        if (line.msg.startsWith('failed to fetch ')) {
                            const workflowStepError = line.msg.match(/GoGitActionCache (?<msg>failed to fetch \S+ with ref \S+)/)?.groups;
                            const errorMessage = workflowStepError?.msg ?? line.msg;
                            concurrentLog(
                                buildStepLogPrefix() +
                                buildStepIndicator(stepIndex) +
                                '::error::' + errorMessage,
                            );
                            DEBUG && concurrentLog(`__::Step::End::${stepIndex}`)
                            stepResult.output += '::error::' + errorMessage + EOL;
                            completeStep(stepIndex, 'error');
                        }
                    } else if (line.msg.startsWith(`⭐ Run ${stage} `)) {
                        DEBUG && concurrentLog(`__::Step::Start::${stepIndex}`);
                        concurrentLog(
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
                        concurrentLog(
                            buildStepLogPrefix('End', stepResult.result) +
                            buildStepIndicator(stepIndex) +
                            buildStepHeadline(stage, step, stepResult),
                        );
                        DEBUG && concurrentLog(`__::Step::End::${stepIndex}`)
                    }
                } else {
                    concurrentLog(
                        buildStepLogPrefix() +
                        buildStepIndicator(stepIndex) +
                        line.msg,
                    );
                    stepResult.output += line.msg + EOL;
                }
            } else if (line.jobResult) {
                if (!stepResult.result && line.jobResult === 'failure') {
                    completeStep(stepIndex, 'error');
                }
            } else if (line.raw_output) {
                const interceptorEvent = line.msg.match(/^__::Interceptor::(?<stage>[^:]+)::(?<type>[^:]+)::(?<value>[^:]*)?/)?.groups;
                if (interceptorEvent) {
                    if (interceptorEvent.stage !== stage) throw Error(`Unexpected stage event: ${line.msg}`);

                    if (interceptorEvent.type === 'Start') {
                        stepResult.status = 'In Progress';
                    } else if (interceptorEvent.type === 'End') {
                        completeStep(stepIndex);
                    }
                }
            }
        });

    // --- create the trigger file to signal step runner to start the next stage
    fs.writeFileSync(path.join(ACTION_STEP_TEMP_DIR, `.Interceptor-${stage}-Stage`), '');

    await stagePromise
        .finally(() => actLogTail.quit());

    function completeStep(stepIndex, result) {
        const stepResult = stepResults[stepIndex];
        stepResult.status = 'Completed';
        if (result) {
            stepResult.result = result;
            if (result === 'error') {
                fs.appendFileSync(errorStepsFilePath, stepIndex + EOL);
            }
        }

        // check if the stage has been completed
        if (Object.values(stepResults).every((result) => result.status === 'Completed')) {
            if (concurrentLogGroupOpen) {
                core.endGroup();
            }

            stepResults.forEach((stepResult, stepIndex) => {
                const step = steps[stepIndex];

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

            // complete stage promise
            if (stepResults.every((result) => !result.result || result.result === 'success')) {
                stagePromise.resolve();
            } else {
                stagePromise.reject();
            }
        }
    }
}

async function startAct(steps, githubToken, logFilePath) {
    // Install gh-act extension
    child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });

    const GITHUB_EVENT_PATH = process.env["GITHUB_EVENT_PATH"];
    const GITHUB_ACTOR = process.env["GITHUB_ACTOR"];
    const WORKING_DIRECTORY = process.cwd();

    const workflow = {
        on: "workflow_dispatch",
        jobs: {},
    }
    for (const [stepIndex, step] of Object.entries(steps)) {
        const jobId = `Step${stepIndex}`;
        workflow.jobs[jobId] = {
            "runs-on": "host", // refers to gh act parameter "--platform", "host=-self-hosted",
            "steps": [
                {
                    uses: "__/act-interceptor@local",
                    with: {
                        'temp-dir': ACTION_STEP_TEMP_DIR,
                        'host-working-directory': WORKING_DIRECTORY,
                    }
                },
                step,
                {
                    if: "always()",
                    uses: "__/act-interceptor@local",
                    with: {
                        'position': 'Main::End',
                        'temp-dir': ACTION_STEP_TEMP_DIR,
                    }
                },
            ],
        };
    }

    const workflowFilePath = path.join(ACTION_STEP_TEMP_DIR, 'steps-workflow.yaml'); // TODO [Multi Act Runner]
    fs.writeFileSync(workflowFilePath, YAML.stringify(workflow));

    fs.writeFileSync(logFilePath, ''); // ensure the file does exist
    const actLogFileDescriptor = fs.openSync(logFilePath, 'w');
    //TODO [Multi Act Runner]
    child_process.spawn(
        "gh", ["act", "--workflows", workflowFilePath,
            "--bind", // do not copy working directory files
            "--platform", "host=-self-hosted",
            "--local-repository", "__/act-interceptor@local" + "=" + `${__dirname}/act-interceptor`,
            GITHUB_EVENT_PATH ? ["--eventpath", GITHUB_EVENT_PATH] : [],
            GITHUB_ACTOR ? ["--actor", GITHUB_ACTOR] : [],
            "--secret", `GITHUB_TOKEN=${githubToken}`,
            "--action-offline-mode",
            "--json",
        ].flat(),
        {
            detached: true,
            stdio: ['ignore', actLogFileDescriptor, actLogFileDescriptor],
            env: {...process.env, GH_TOKEN: githubToken},
        }
    ).unref();
}

// --- Utility functions ---

function getInput(name, options, fn) {
    const value = core.getInput(name, options);
    return fn(value);
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