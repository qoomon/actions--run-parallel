import core from '@actions/core';
import {LOCAL, untilFilePresent} from "./utils.js";
import fs from "node:fs/promises";
import path from "node:path";

const step = core.getInput('step', {required: true});
if (step === 'Pre') {
    const hostWorkingDirectory = core.getInput("host-working-directory", {required: true});
    const hostEnv = JSON.parse(core.getInput("host-env", {required: true}));

    if (!LOCAL) {
        // --- Link job working directory to host working directory
        const jobWorkingDirectory = process.cwd();
        await fs.rm(jobWorkingDirectory, {recursive: true});
        await fs.symlink(hostWorkingDirectory, jobWorkingDirectory);
    }

    // set host environment variables
    Object.entries(hostEnv).forEach(([name, val]) => {
        core.exportVariable(name, val);
    });

    const stage = 'Pre';
    const tempDir = core.getInput("temp-dir", {required: true});
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
}