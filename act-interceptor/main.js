import core from "@actions/core";
import {untilFilePresent} from "./utils.js";
import path from "node:path";

const position = core.getInput('position');
const tempDir = core.getInput("temp-dir", {required: true});

if (!position) {
    console.log('__::Interceptor::Pre::End::');

    const stage = 'Main';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
} else if (position === 'Main::End') {
    console.log('__::Interceptor::Main::End::');

    const stage = 'Post';
    await untilFilePresent(path.join(tempDir, `.Interceptor-${stage}-Stage`));
    console.log(`__::Interceptor::${stage}::Start::`);
} else {
    throw new Error(`Unexpected sub stage: ${position}.`);
}
