import core from "@actions/core";

const position = core.getInput('position');
if (!position) {
    const stage = 'Post';
    console.log(`__::Interceptor::${stage}::End::`);
}
