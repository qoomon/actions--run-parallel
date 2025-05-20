import core from '@actions/core';
import {LOCAL, untilFilePresent} from "./utils.js";
import fs from "node:fs";
import path from "node:path";

const step = core.getInput('step', {required: true});
if (step === 'Pre') {
    const hostWorkingDirectory = core.getInput("host-working-directory", {required: true});

    if (!LOCAL) {
        // --- Link job working directory to host working directory
        const jobWorkingDirectory = process.cwd();
        fs.rmSync(jobWorkingDirectory, {recursive: true});
        fs.symlinkSync(hostWorkingDirectory, jobWorkingDirectory);
    }

    const stage = 'Pre';
    const tempDir = core.getInput("temp-dir", {required: true});
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
}