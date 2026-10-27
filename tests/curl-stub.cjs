// Answers for the agent release: an asset is the one in a published index whose key the URL ends with, and every URL
// asked for is written down beside that index.
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const args = process.argv.slice(2);
const url = args.at(-1);
const output = args[args.indexOf('--output') + 1];
appendFileSync(process.env.STUB_ASKED, `${url}\n`);
const published = JSON.parse(readFileSync(process.env.STUB_RELEASE, 'utf8'));
const suffix = Object.keys(published).find((key) => url.endsWith(key));
if (suffix === undefined) {
  console.error('404 Not Found');
  process.exit(22);
}
// The digest is read from what curl prints, so that request writes to the terminal rather than to a file.
if (output === '-') process.stdout.write(published[suffix]);
else writeFileSync(output, published[suffix]);
