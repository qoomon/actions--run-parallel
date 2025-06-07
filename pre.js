import child_process from "node:child_process";
import core, {ExitCode} from "@actions/core";
import {GH_ACT_VERSION} from "./steps-runner.js";

const GH_ACT_VERSION_TAG = `v${GH_ACT_VERSION}`;

try {
    const githubToken = core.getInput("token", {required: true});
    // Install gh-act extension
    console.log(`Installing gh cli extension nektos/gh-act@${GH_ACT_VERSION_TAG} ...`);
    child_process.execSync(`gh extension install https://github.com/nektos/gh-act --pin ${GH_ACT_VERSION_TAG}`, {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });
    const actVersionOutput = child_process.execSync("gh act --version").toString();
    console.log(actVersionOutput);
    if(!actVersionOutput.endsWith(GH_ACT_VERSION)) {
        core.warning(`gh-act version does not match the requested version ${GH_ACT_VERSION}.`);
    }
} catch (error) {
    process.exitCode = ExitCode.Failure;
    if (error?.message) {
        core.setFailed(error.message);
    }
}