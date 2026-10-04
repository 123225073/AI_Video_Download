const fs = require('fs');
const path = require('path');
const sharp = require('C:/Users/CM1165/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect x="4" y="4" width="248" height="248" rx="58" fill="#2877fa"/><g stroke="white" stroke-width="14" fill="none" stroke-linecap="round"><path d="M52 101h106c42 0 42-52 10-52-18 0-24 11-24 21"/><path d="M43 135h142c37 0 37 48 6 48-15 0-22-8-22-17"/><path d="M60 169h56c31 0 31 40 5 40-13 0-19-7-19-14"/></g></svg>';
sharp(Buffer.from(svg)).png().toBuffer().then(png => { fs.writeFileSync('assets/icon.png', png); const head = Buffer.alloc(22); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18); fs.writeFileSync('assets/icon.ico', Buffer.concat([head, png])); });
