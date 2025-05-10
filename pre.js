import core from '@actions/core';
import YAML from 'yaml';
import child_process from 'node:child_process';
import readline from 'node:readline';
import path from "node:path";
import {fileURLToPath} from "url";
import {dirname} from "path";
import {newStageHandler} from "./stage-handler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const githubToken = core.getInput("token", {required: true});
const steps = YAML.parse(core.getInput("steps", {required: true}));

if (!Array.isArray(steps)) {
    throw new Error("steps must be an array");
}

// Install gh-act extension
child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
    stdio: 'inherit',
    env: {...process.env, GH_TOKEN: githubToken}
});

const actRunnerProcess = child_process.spawn(process.execPath, [
    path.join(__dirname, 'act-parallel-steps-runner.js'),
    YAML.stringify(steps),
], {
    stdio: 'ignore',
    env: {...process.env, GH_TOKEN: githubToken},
    detached: true,
})
actRunnerProcess.unref();

// --------------------

await newStageHandler('Pre');
