import core from "@actions/core";
import {untilFilePresent} from "./utils.js";
import path from "node:path";

const step = core.getInput('step', {required: true});
const tempDir = core.getInput("temp-dir", {required: true});

if (step === 'Pre') {
    console.log('__::Interceptor::Pre::End::');

    const stage = 'Main';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
} else if (step === 'Post') {
    console.log('__::Interceptor::Main::End::');

    const stage = 'Post';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
} else {
    throw new Error(`Unexpected step: ${step}.`);
}
