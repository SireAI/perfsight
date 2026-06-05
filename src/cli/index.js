import { parseArgs, printHelp } from './args.js';
import { run } from '../app/run.js';

export async function main(argv) {
  const { command, packageName, options, helpTopic } = parseArgs(argv);
  if (options.help) {
    const topic = helpTopic || (command === 'text' || command === 'web' ? command : '');
    printHelp(process.stdout, topic);
    return;
  }
  if (!packageName) {
    printHelp(process.stderr);
    process.exitCode = 2;
    return;
  }
  await run({ packageName, options });
}
