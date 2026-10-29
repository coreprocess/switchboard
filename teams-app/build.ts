/**
 * Builds the Teams app package (manifest.json + icons, zipped) for upload as a custom app.
 *
 *   node teams-app/build.ts --bot-id <app id> [--app-id <guid>] [--version 1.0.0] [--name Switchboard]
 *       [--short-description …] [--full-description …] [--developer-name …] [--website-url …]
 *       [--privacy-url …] [--terms-url …] [--out teams-app/build/switchboard.zip]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32 } from 'node:zlib';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const here = dirname(new URL(import.meta.url).pathname);
const REPO = 'https://github.com/coreprocess/switchboard';

const { values } = parseArgs({
    options: {
        'bot-id': { type: 'string' },
        'app-id': { type: 'string' },
        version: { type: 'string', default: '1.0.0' },
        name: { type: 'string', default: 'Switchboard' },
        'short-description': { type: 'string', default: 'Talk to Claude agents in this channel.' },
        'full-description': {
            type: 'string',
            default:
                'Connects this channel to a Claude agent. Mention the app to start a conversation; replies in the ' +
                'thread go to the same agent session. Agents post updates and ask for approval here.',
        },
        'developer-name': { type: 'string', default: 'Switchboard' },
        'website-url': { type: 'string', default: REPO },
        'privacy-url': { type: 'string', default: REPO },
        'terms-url': { type: 'string', default: REPO },
        out: { type: 'string', default: join(here, 'build', 'switchboard.zip') },
    },
});

const botId = values['bot-id'];
if (!botId || !GUID.test(botId)) {
    console.error('--bot-id <app id> is required: the client ID of the bot app registration');
    process.exit(2);
}
const appId = values['app-id'] ?? botId;
if (!GUID.test(appId)) {
    console.error('--app-id must be a GUID');
    process.exit(2);
}

const placeholders: Record<string, string> = {
    BOT_ID: botId,
    APP_ID: appId,
    VERSION: values.version,
    NAME: values.name,
    SHORT_DESCRIPTION: values['short-description'],
    FULL_DESCRIPTION: values['full-description'],
    DEVELOPER_NAME: values['developer-name'],
    WEBSITE_URL: values['website-url'],
    PRIVACY_URL: values['privacy-url'],
    TERMS_URL: values['terms-url'],
};
const manifest = readFileSync(join(here, 'manifest.template.json'), 'utf8').replace(
    /\{\{([A-Z_]+)\}\}/g,
    (_, key: string) => {
        const value = placeholders[key];
        if (value === undefined) throw new Error(`unknown placeholder ${key}`);
        return JSON.stringify(value).slice(1, -1);
    }
);
JSON.parse(manifest);

/** A minimal ZIP writer (stored entries): enough for a Teams package, no dependency. */
const zip = (files: { name: string; data: Buffer }[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, data);
        centrals.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
};

const out = values.out;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
    out,
    zip([
        { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
        { name: 'color.png', data: readFileSync(join(here, 'color.png')) },
        { name: 'outline.png', data: readFileSync(join(here, 'outline.png')) },
    ])
);
console.log(`${out} (bot ${botId}, app ${appId}, version ${values.version})`);
