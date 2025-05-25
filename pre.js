import child_process from "node:child_process";
import core, {ExitCode} from "@actions/core";

try {
    const githubToken = core.getInput("token", {required: true});
    // Install gh-act extension
    const actVersionTag = 'v0.2.76';
    console.log(`Installing gh cli extension nektos/gh-act@${actVersionTag} ...`);
    child_process.execSync(`gh extension install https://github.com/nektos/gh-act --pin ${actVersionTag}`, {
        stdio: 'inherit',
        env: {...process.env, GH_TOKEN: githubToken}
    });
    child_process.execSync("gh act --version", {
        stdio: 'inherit',
    });
} catch (error) {
    process.exitCode = ExitCode.Failure;
    if (error?.message) {
        core.setFailed(error.message);
    }
}