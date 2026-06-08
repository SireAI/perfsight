const BOOL_FLAGS = new Set([
  'help',
  'enable-leak-capture',
  'check-update',
  'force',
  'reset-output-dir'
]);

const OPTION_DEFAULTS = {
  interval: 0.5,
  'pss-interval': 3.0,
  'history-size': 120,
  'output-dir': 'data',
  host: '127.0.0.1',
  port: 8765,
  'leak-java-max-heap-mb': 0,
  'leak-java-watch-ratio': 0.7,
  'leak-java-dump-ratio': 0.8,
  'leak-dump-threshold-mb': 256,
  'leak-cooldown-sec': 900,
  'leak-max-dumps-per-pid': 2,
  'leak-max-dumps-per-session': 3,
  'leak-dump-dir': 'captures'
};

const NUMBER_OPTIONS = new Set([
  'interval',
  'pss-interval',
  'history-size',
  'port',
  'leak-java-max-heap-mb',
  'leak-java-watch-ratio',
  'leak-java-dump-ratio',
  'leak-dump-threshold-mb',
  'leak-cooldown-sec',
  'leak-max-dumps-per-pid',
  'leak-max-dumps-per-session'
]);

export function parseArgs(argv) {
  const options = { ...OPTION_DEFAULTS };
  const positionals = [];
  let command = '';
  let helpTopic = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const [name, inlineValue] = raw.split(/=(.*)/s, 2);
    if (BOOL_FLAGS.has(name)) {
      options[name] = true;
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++index];
    if (value === undefined) {
      throw new Error(`missing value for --${name}`);
    }
    options[name] = NUMBER_OPTIONS.has(name) ? Number(value) : value;
  }
  if (positionals[0] === 'help') {
    command = 'help';
    helpTopic = positionals[1] || '';
    options.help = true;
  } else if (positionals[0] === 'text' || positionals[0] === 'web' || positionals[0] === 'version' || positionals[0] === 'upgrade') {
    command = positionals[0];
    if (command === 'text' || command === 'web') {
      options.mode = command;
    }
  }
  const packageName = command === 'text' || command === 'web' ? positionals[1] : '';
  return {
    command,
    helpTopic,
    packageName,
    options
  };
}

export function printHelp(output = process.stdout, topic = '') {
  const normalized = String(topic || '').trim().toLowerCase();
  if (normalized === 'text' || normalized === 'cli') {
    output.write(`Usage: perfsight text <package> [options]

Text mode prints live samples in the terminal and writes CSV/session metadata.

Examples:
  perfsight text com.example.app
  perfsight text com.example.app --enable-leak-capture
  perfsight text com.example.app --interval 1
  perfsight text com.example.app --serial emulator-5554

Text-mode options:
  --interval <sec>                        CPU sample interval (default: 0.5)
  --pss-interval <sec>                    dumpsys meminfo refresh interval (default: 3)
  --output-dir <dir>                      Output directory (default: data)
  --reset-output-dir                      Clear this package's existing artifacts under output-dir before run
  --serial <device-id>                    adb device serial
  --dump-hook <command>                   Run a script or command after dump completion

Run \`perfsight help leak-capture\` for optional leak detection options.
`);
    return;
  }

  if (normalized === 'web') {
    output.write(`Usage: perfsight web <package> [options]

Web mode starts a local HTTP server and shows live CPU, PSS, leak, and dump state.

Examples:
  perfsight web com.example.app
  perfsight web com.example.app --enable-leak-capture
  perfsight web com.example.app --port 9000

Web options:
  --host <host>                           Web bind host (default: 127.0.0.1)
  --port <port>                           Web bind port (default: 8765)
  --history-size <n>                      Web sample history size (default: 120)
  --reset-output-dir                      Clear this package's existing artifacts under output-dir before run
  --dump-hook <command>                   Run a script or command after dump completion

Run \`perfsight help leak-capture\` for optional leak detection options.
`);
    return;
  }

  if (normalized === 'leak' || normalized === 'leak-capture') {
    output.write(`Usage: perfsight text <package> --enable-leak-capture [options]
       perfsight web <package> --enable-leak-capture [options]

Leak capture uses only:
  1. structure rule: Activities - ViewRootImpl
  2. watermark rule: java_heap_mb / java_heap_max_mb

Examples:
  perfsight text com.example.app --enable-leak-capture
  perfsight web com.example.app --enable-leak-capture
  perfsight text com.example.app --enable-leak-capture --leak-java-max-heap-mb 512
  perfsight web com.example.app --enable-leak-capture --leak-java-dump-ratio 0.85

Leak options:
  --enable-leak-capture                   Enable leak detection and automatic HPROF dump
  --leak-java-max-heap-mb <mb>            Max Java Heap; 0 reads dalvik.vm.heapgrowthlimit
  --leak-java-watch-ratio <ratio>         Watermark watch ratio (default: 0.70)
  --leak-java-dump-ratio <ratio>          Watermark dump ratio (default: 0.80)
  --leak-dump-threshold-mb <mb>           Total PSS threshold for structure-only dumps
  --leak-cooldown-sec <sec>               Cooldown after one automatic dump
  --leak-max-dumps-per-pid <n>            Max automatic dumps per pid
  --leak-max-dumps-per-session <n>        Max automatic dumps per session
  --leak-dump-dir <dir>                   HPROF capture directory under output-dir
  --dump-hook <command>                   Run a script or command after dump completion

Run \`perfsight help\` to see all options.
`);
    return;
  }

  if (normalized === 'version') {
    output.write(`Usage: perfsight version [options]

Show the installed version and optionally force an update check.

Examples:
  perfsight version
  perfsight version --check-update
  perfsight version --channel snapshot --check-update

Version options:
  --check-update                         Force a fresh npm version check
  --channel <latest|snapshot>            Release channel
`);
    return;
  }

  if (normalized === 'upgrade') {
    output.write(`Usage: perfsight upgrade [options]

Upgrade the npm CLI when installed globally.

Examples:
  perfsight upgrade
  perfsight upgrade --channel snapshot
  perfsight upgrade --force

Upgrade options:
  --channel <latest|snapshot>            Release channel
  --force                                Reinstall even when already latest
`);
    return;
  }

  output.write(`Usage: perfsight text <package> [options]
       perfsight web <package> [options]
       perfsight version [options]
       perfsight upgrade [options]
       perfsight help [text|web|leak-capture|version|upgrade]

Android app CPU, PSS, leak watermark, and HPROF capture watcher over adb.

Modes:
  1. text mode
     perfsight text com.example.app
     perfsight text com.example.app --enable-leak-capture
  2. web mode
     perfsight web com.example.app
     perfsight web com.example.app --enable-leak-capture

Commands:
  version                                Show installed version and update status
  upgrade                                Upgrade global npm install

Common options:
  --interval <sec>                        CPU sample interval (default: 0.5)
  --pss-interval <sec>                    dumpsys meminfo refresh interval (default: 3)
  --output-dir <dir>                      Output directory (default: data)
  --reset-output-dir                      Clear this package's existing artifacts under output-dir before run
  --serial <device-id>                    adb device serial
  --dump-hook <command>                   Run a script or command after dump completion

Web options:
  --host <host>                           Web bind host (default: 127.0.0.1)
  --port <port>                           Web bind port (default: 8765)
  --history-size <n>                      Web sample history size (default: 120)

Leak options:
  --enable-leak-capture                   Enable leak detection and automatic HPROF dump
  --leak-java-max-heap-mb <mb>            Max Java Heap; 0 reads dalvik.vm.heapgrowthlimit
  --leak-java-watch-ratio <ratio>         Watermark watch ratio (default: 0.70)
  --leak-java-dump-ratio <ratio>          Watermark dump ratio (default: 0.80)
  --leak-dump-threshold-mb <mb>           Total PSS threshold for structure-only dumps
  --leak-cooldown-sec <sec>               Cooldown after one automatic dump
  --leak-max-dumps-per-pid <n>            Max automatic dumps per pid
  --leak-max-dumps-per-session <n>        Max automatic dumps per session
  --leak-dump-dir <dir>                   HPROF capture directory under output-dir
  --channel <latest|snapshot>             Release channel for version/upgrade
  --check-update                          Force a fresh npm version check
  --force                                 Reinstall even when already latest
  --help                                  Show this help

Topics:
  help text                               Show text-mode usage
  help web                                Show web-mode usage
  help leak-capture                       Show leak-capture usage
  help version                            Show version usage
  help upgrade                            Show upgrade usage
`);
}
