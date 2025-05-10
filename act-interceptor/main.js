import core from "@actions/core";
import {untilFilePresent} from "./utils.js";
import path from "node:path";

const subStage = core.getInput('sub-stage');
const tempDir = core.getInput("temp-dir", {required: true});

if (!subStage) {
    console.log('__::Interceptor::Pre::End::');

    const stage = 'Main';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
    process.exit(0);
}

if (subStage === 'Main::After') {
    console.log('__::Interceptor::Main::End::');

    const stage = 'Post';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
    process.exit(0);
}

throw new Error(`Unexpected sub stage: ${subStage}.`);
