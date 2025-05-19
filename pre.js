import core, {error} from '@actions/core';
import YAML from 'yaml';
import child_process from 'node:child_process';
import {init, run} from "./steps-runner.js";

const githubToken = core.getInput("token", {required: true});
let steps = core.getInput("steps", {required: true});
try {
    steps = YAML.parse(steps);
} catch (e) {
    core.setFailed(`Invalid steps input - Invalid YAML - ${e.message}`);
    process.exit(1);
}
if (!Array.isArray(steps)) {
    core.setFailed(`Invalid steps input - Must be an YAML array`);
    process.exit(1);
}

// Install gh-act extension
child_process.execSync("gh extension install https://github.com/nektos/gh-act", {
    stdio: 'inherit',
    env: {...process.env, GH_TOKEN: githubToken}
});

await init(steps, githubToken).catch((error) => {
    core.setFailed(error.message);
    process.exit(1);
});

// --------------------

await run('Pre');
