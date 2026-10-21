import { createRequire, syncBuiltinESMExports } from 'node:module';

// Tests isolate the home dir by setting process.env.HOME. Node's os.homedir()
// honours HOME on POSIX but reads USERPROFILE on Windows, so there a test that
// only sets HOME would read and write the developer's real ~/.pixel-agents and
// ~/.claude. Make os.homedir() follow HOME everywhere, for every test file.
// (Tests that vi.mock('os') replace this entirely, which is fine.)
const os = createRequire(import.meta.url)('node:os') as typeof import('node:os');
const realHomedir = os.homedir;
os.homedir = () => process.env.HOME || realHomedir();
syncBuiltinESMExports();
