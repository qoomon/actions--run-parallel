import core from "@actions/core";

const stage = core.getInput('stage');
if(stage) {
    process.exit(0);
}

// TODO log only once
console.log('__::act-interceptor::Post-End::');