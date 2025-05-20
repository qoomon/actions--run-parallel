import {run} from "./steps-runner.js";
import core, {ExitCode} from "@actions/core";

await run('Pre').catch((error) => {
    process.exitCode = ExitCode.Failure;
    if(error?.message) {
        core.setFailed(error.message);
    }
});
