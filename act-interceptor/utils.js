import fs from "node:fs";
import {EOL} from "node:os";

export const DEBUG = process.env["RUNNER_DEBUG"] === "1";
export const LOCAL = process.env["RUNNER_LOCAL"] === "1";

export async function untilFilePresent(filePath, interval = 100) {
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

export function extendBasename(filePath, annex) {
    const pathSplit = filePath.split('/');
    pathSplit.push(pathSplit.pop().replace(/^([^.]+)/, '$1' + annex));
    return pathSplit.join('/');
}

export function ensureNewline(text) {
    return text.endsWith('\n') ? text : text + '\n';
}

export function leftPad(pad, text) {
    return pad + text.split(EOL).join('\n' + pad);
}

export function colorizeCyan(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;36m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeGray(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;90m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeRed(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;31m${line}\x1b[0m`)
        .join('\n');
}

export function colorizeYellow(value) {
    return value.split("\n")
        .map((line) => `\x1b[1;33m${line}\x1b[0m`)
        .join('\n');
}

export function formatMilliseconds(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const seconds = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = totalMinutes % 60;
    const hours = Math.floor(totalMinutes / 60);

    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }
    if (seconds > 0) {
        parts.push(`${seconds}s`);
    }
    if (parts.length) {
        return parts.join(" ");
    }

    return `${milliseconds}ms`;
}