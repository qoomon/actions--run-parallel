import fs from "node:fs";
import path from "node:path";
import TailFile from "@logdna/tail-file";
import {untilFilePresent} from "./utils.js";
import core from "@actions/core";
import readline from "node:readline";

const stage = 'main';
console.log(`__::${stage}::`);
// --- send the main stage signal to act-interceptor
// TODO better file location
fs.writeFileSync(process.cwd() + `/.${stage}-step`, '');

const tempDir = process.cwd(); // TODO `${process.env["RUNNER_TEMP"] ?? '/tmp'}/${github.context.action}`;
fs.mkdirSync(tempDir, {recursive: true});

const actOutputFilePath = path.join(tempDir, "act-parallel-steps-output");
await untilFilePresent(actOutputFilePath);

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
        console.log(stage, line.msg);
        core.endGroup();

        // actOutputTailStream.destroy();
        // TODO exit gracefully
        process.exit(0);
    } else {
        console.log(line.msg);
    }
});