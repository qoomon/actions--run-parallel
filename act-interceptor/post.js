import core from "@actions/core";

const subStage = core.getInput('sub-stage');
if(subStage) {
    process.exit(0);
}

const stage = 'Post';
console.log(`__::Interceptor::${stage}::End::`);
