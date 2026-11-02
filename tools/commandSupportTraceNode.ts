import {writeFileSync} from 'node:fs';
import {commandSupportTrace} from './commandSupportTrace';
writeFileSync(process.argv[2],JSON.stringify(commandSupportTrace()));
