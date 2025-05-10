import core from '@actions/core';
import YAML from 'yaml';
import child_process from 'node:child_process';
import {init, run} from "./steps-runner.js";

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

await init(steps, githubToken);
// --------------------

await run('Pre');
