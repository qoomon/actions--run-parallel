import fs from "node:fs";
import path from "node:path";
import TailFile from "@logdna/tail-file";
import {untilFilePresent} from "./act-interceptor/utils.js";
import readline from "node:readline";
import {DEBUG} from "./act-interceptor/utils.js";
import core from "@actions/core";

export async function newStageHandler(stage) {
    DEBUG && console.log(`__::Action::${stage}::Start::`);

    core.startGroup("FUCK YOU");
    core.endGroup();

    const tempDir = process.cwd(); // TODO `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
    fs.mkdirSync(tempDir, {recursive: true});

    // --- create the trigger file to signal step runner to start the next stage
    fs.writeFileSync(path.join(tempDir, `.Runner-${stage}-Stage`), '');

    const actOutputFilePath = path.join(tempDir, `.Runner-${stage}-Stage-Output`);
    await untilFilePresent(actOutputFilePath);
    const actOutputTailStream = new TailFile(actOutputFilePath, {startPos: 0})
        .on('tail_error', (err) => console.error(err));
    await actOutputTailStream.start();
    readline.createInterface({input: actOutputTailStream, crlfDelay: Infinity})
        .on('line', (line) => {
            if (line) {
                const stageEvent = line.match(/^__::(?<source>[^:]+)::(?<stage>[^:]+)::(?<event>[^:]+)::/)?.groups;
                if (stageEvent) {
                    DEBUG && console.log(line);
                    if (stageEvent.stage === stage && stageEvent.event === 'End') {
                        DEBUG && console.log(`__::Action::${stage}::End::`);
                        process.exit(0);
                    }
                } else {
                    console.log(line)
                }
            }
        });
}

