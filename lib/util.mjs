// Small helpers more than one module needs.

import { homedir } from 'node:os';

// A path as it's typed in Settings or a rule, with ~ as your home folder.
export const untilde = (p, home = homedir()) => String(p).replace(/^~(?=\/|$)/, home);
