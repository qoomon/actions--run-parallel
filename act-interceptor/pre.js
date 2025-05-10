import core from '@actions/core';
import {LOCAL, untilFilePresent} from "./utils.js";
import fs from "node:fs";
import path from "node:path";

const subStage = core.getInput('sub-stage');
if(subStage) {
    process.exit(0);
}

const stage = 'Pre';
const tempDir = core.getInput("temp-dir", {required: true});
await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
console.log(`__::Interceptor::${stage}::Start::`);

const hostWorkingDirectory = core.getInput("host-working-directory", {required: true});
const hostCommandFiles = core.getInput("command-files")
    .split('\n').filter(line => !!line.trim())
    .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [
            line.substring(0, separatorIndex),
            line.substring(separatorIndex + 1),
        ];
    });

if(LOCAL) {
    process.exit(0);
}

// --- Link job working directory to host working directory
const jobWorkingDirectory = process.cwd();
fs.rmSync(jobWorkingDirectory, {recursive: true});
fs.symlinkSync(hostWorkingDirectory, jobWorkingDirectory);

// --- Link job command files to host files
for (const [varName, hostCommandFile] of hostCommandFiles) {
    const jobCommandFile = process.env[varName];
    fs.rmSync(jobCommandFile);
    fs.symlinkSync(hostCommandFile, jobCommandFile);
}
