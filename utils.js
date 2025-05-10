import fs from "node:fs";

export async function untilFilePresent(filePath, interval = 1000) {
    let fileExists = fs.existsSync(filePath);
    while (!fileExists) {
        await sleep(interval);
        fileExists = fs.existsSync(filePath);
    }
    return fileExists;
}

export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}