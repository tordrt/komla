import { readFileSync } from 'fs';
import { join } from 'path';

import { KOMLA_SKILL_NAME } from '../../shared/constants/komla-skill';
import { getKomlaBasePath } from '../services/paths';

/** The Komla skill's SKILL.md, as installBundledSkills copies it into Komla's data dir. */
export function readKomlaSkill(): string {
  return readFileSync(join(getKomlaBasePath(), 'skills', KOMLA_SKILL_NAME, 'SKILL.md'), 'utf-8');
}
