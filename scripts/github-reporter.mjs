import { inspect } from 'node:util';

// Make failing assertions visible in public Actions annotations even when log
// downloads require authentication. The suite uses only public/synthetic data.
const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export default async function* report(events) {
  for await (const { type, data } of events) {
    if (process.env.GITHUB_ACTIONS !== 'true' || type !== 'test:fail') continue;
    const error = data.details?.error;
    if (error?.failureType === 'subtestsFailed') continue;
    yield `::error::${escape(data.name + '\n' + inspect(error?.cause || error, { depth: 4 }).slice(0, 6000))}\n`;
  }
}
