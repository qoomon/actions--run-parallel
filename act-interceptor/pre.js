import core from '@actions/core';
import {DEBUG, untilFilePresent} from "./utils.js";

const stage = core.getInput('stage');
if(stage) {
    process.exit(0);
}

// TODO better file location
const stepTriggerFilePath = process.cwd() + '/.pre-step';
DEBUG && console.log("pre trigger file:", stepTriggerFilePath);
await untilFilePresent(stepTriggerFilePath);

console.log('__::act-interceptor::Pre-Start::');

// --- Link job working directory to host working directory

const hostWorkingDirectory = core.getInput("host-working-directory", {required: true});

// TODO
// const jobWorkingDirectory = process.cwd();
// fs.rmSync(jobWorkingDirectory, {recursive: true});
// fs.symlinkSync(hostWorkingDirectory, jobWorkingDirectory);

// --- Link job command files to host files

const hostCommandFiles = core.getInput("command-files")
    .split('\n').filter(line => !!line.trim())
    .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [
            line.substring(0, separatorIndex),
            line.substring(separatorIndex + 1),
        ];
    });

// TODO
// for (const [varName, hostCommandFile] of hostCommandFiles) {
//     const jobCommandFile = process.env[varName];
//     fs.rmSync(jobCommandFile);
//     fs.symlinkSync(hostCommandFile, jobCommandFile);
// }
