import core from "@actions/core";
import {DEBUG, untilFilePresent} from "./utils.js";


const stage = core.getInput('stage');

if (!stage) {
  console.log('__::act-interceptor::Pre-End::');

  // TODO better file location
  const stepTriggerFilePath = process.cwd() + '/.main-step';
  DEBUG && console.log("main trigger file:", stepTriggerFilePath);
  await untilFilePresent(stepTriggerFilePath);

  console.log('__::act-interceptor::Main-Start::');
  process.exit(0);
}

if (stage === 'main-end') {
    console.log('__::act-interceptor::Main-End::');

    // TODO better file location
    const stepTriggerFilePath = process.cwd() + '/.post-step';
    DEBUG && console.log("post trigger file:", stepTriggerFilePath);
    await untilFilePresent(stepTriggerFilePath);

    console.log('__::act-interceptor::Post-Start::');
    process.exit(0);
}

throw new Error(`Unexpected stage: ${stage}.`);
