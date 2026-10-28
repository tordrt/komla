import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

import { is } from '@electron-toolkit/utils';

import { KOMLA_SKILL_NAME } from '../../shared/constants/komla-skill';
import { getKomlaBasePath } from '../services/paths';

import { createLogger } from './logger';
import { MAIN_BUNDLE_DIR } from './module-path';

const logger = createLogger('InstallSkills');

/**
 * Get the path to the bundled skills directory.
 * In dev mode, skills are in the repo's resources/skills/.
 * In production, they're in the app's extraResources.
 */
function getBundledSkillsPath(): string {
  return is.dev
    ? join(MAIN_BUNDLE_DIR, '../../resources/skills')
    : join(process.resourcesPath, 'skills');
}

/** Skills are directories containing a SKILL.md file */
const SKILL_DIRS = [KOMLA_SKILL_NAME];

/**
 * Loose markdown files that sit alongside the skill dirs in <komlaDir>/skills/
 * but are NOT installed by `npx skills add`. `komla skill <guide>` fetches these
 * over HTTP through KOMLA_API_URL, or reads them here when Komla can't be
 * reached, so their content stays fresh on every Komla start without
 * reinstalling the skill.
 */
const SKILL_LOOSE_FILES = [
  'komla-appearance-instructions.md',
  'komla-customize-instructions.md',
  'komla-status-items-instructions.md',
  'komla-automations-instructions.md',
  'komla-project-setup-instructions.md',
  'komla-onboarding-demo-instructions.md',
  'komla-self-integration-instructions.md',
];

/**
 * Copy one file, substituting `{{komlaDir}}` with the current Komla data dir,
 * so dev (~/.komla-dev) and sandbox (/tmp/komla-dev) installs point at the
 * right paths.
 */
function copyWithSubstitution(srcFile: string, destFile: string, komlaDir: string): void {
  const content = readFileSync(srcFile, 'utf-8');
  writeFileSync(destFile, content.replaceAll('{{komlaDir}}', komlaDir), 'utf-8');
}

/** Recursively copy a directory, substituting placeholders in every file. */
function copyDirWithSubstitution(srcDir: string, destDir: string, komlaDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirWithSubstitution(srcPath, destPath, komlaDir);
    } else {
      copyWithSubstitution(srcPath, destPath, komlaDir);
    }
  }
}

/**
 * Copy bundled skill directories and loose instruction files to <komlaDir>/skills/.
 * Replaces destination skill directories entirely to remove stale files from
 * previous versions, and overwrites loose files in place. Substitutes
 * `{{komlaDir}}` in every file. Bundled skills discover the live server from
 * KOMLA_API_URL. Accepts an optional source path override for testing.
 */
export function installBundledSkills(sourcePath?: string): void {
  const source = sourcePath ?? getBundledSkillsPath();
  const komlaDir = getKomlaBasePath();
  const destDir = join(komlaDir, 'skills');

  try {
    mkdirSync(destDir, { recursive: true });

    for (const skillDir of SKILL_DIRS) {
      const srcSkillDir = join(source, skillDir);
      const srcFile = join(srcSkillDir, 'SKILL.md');
      const destSkillDir = join(destDir, skillDir);

      if (!existsSync(srcFile)) {
        logger.warn(`Bundled skill not found: ${srcFile}`);
        continue;
      }

      // Remove destination to clear stale files from previous versions
      if (existsSync(destSkillDir)) {
        rmSync(destSkillDir, { recursive: true, force: true });
      }

      copyDirWithSubstitution(srcSkillDir, destSkillDir, komlaDir);

      logger.debug(`Installed skill: ${skillDir}`);
    }

    for (const looseFile of SKILL_LOOSE_FILES) {
      const srcLoose = join(source, looseFile);
      const destLoose = join(destDir, looseFile);

      if (!existsSync(srcLoose)) {
        logger.warn(`Bundled skill file not found: ${srcLoose}`);
        continue;
      }

      copyWithSubstitution(srcLoose, destLoose, komlaDir);
      logger.debug(`Installed skill file: ${looseFile}`);
    }
  } catch (error) {
    logger.error('Failed to install bundled skills', { error });
  }
}
