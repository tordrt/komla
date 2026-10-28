import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

import {
  KOMLA_SKILLS_FOLDERS,
  komlaSkillFileSegments,
  isKomlaSkill,
} from '../../shared/constants/komla-skill';
import { readKomlaSkill } from '../lib/komla-skill-file';
import { createLogger } from '../lib/logger';

import type { SkillsFolder } from '../../shared/constants/komla-skill';
import type { KomlaSkillStatus } from '../../shared/types/komla-skill';

const logger = createLogger('KomlaSkillService');

function skillFile(folder: SkillsFolder): string {
  return join(homedir(), ...komlaSkillFileSegments(folder));
}

/** The SKILL.md files the skill goes in on this computer. */
function targetFiles(): string[] {
  return KOMLA_SKILLS_FOLDERS.filter(
    (folder) => !folder.onlyWith || existsSync(join(homedir(), folder.onlyWith))
  ).map(skillFile);
}

function readInstalled(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function hasKomlaSkill(file: string): boolean {
  const installed = readInstalled(file);
  return installed !== null && isKomlaSkill(installed);
}

/** Adds the Komla skill to the user-level skills folders agents read on this computer. */
class KomlaSkillService {
  getStatus(): KomlaSkillStatus {
    return {
      isConfigured: KOMLA_SKILLS_FOLDERS.map(skillFile).some(hasKomlaSkill),
      paths: targetFiles(),
    };
  }

  enable(): void {
    const skill = readKomlaSkill();
    for (const file of targetFiles()) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, skill, 'utf-8');
    }
    logger.info('Added the Komla skill');
  }

  /** Removes each skill folder whose SKILL.md is Komla's. */
  disable(): void {
    for (const file of KOMLA_SKILLS_FOLDERS.map(skillFile)) {
      if (hasKomlaSkill(file)) rmSync(dirname(file), { recursive: true, force: true });
    }
    logger.info('Removed the Komla skill');
  }

  /**
   * While the skill is on, writes this version's to each skills folder that lacks it or has an
   * older one, on startup, such as Antigravity CLI's once it is installed.
   */
  refreshInstalled(): void {
    if (!this.getStatus().isConfigured) return;
    let bundled: string;
    try {
      bundled = readKomlaSkill();
    } catch (error) {
      logger.warn('Bundled Komla skill not found', { error });
      return;
    }
    for (const file of targetFiles()) {
      const installed = readInstalled(file);
      if (installed === bundled || (installed !== null && !isKomlaSkill(installed))) continue;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bundled, 'utf-8');
      } catch (error) {
        logger.warn('Failed to refresh the Komla skill', { file, error });
      }
    }
  }
}

export const komlaSkillService = new KomlaSkillService();
