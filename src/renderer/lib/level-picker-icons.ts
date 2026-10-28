import {
  Atom,
  Brain,
  Cpu,
  Fire,
  Flask,
  Gauge,
  Lightbulb,
  Lightning,
  Rocket,
  SlidersHorizontal,
  Sparkle,
  Timer,
  type Icon,
} from '@phosphor-icons/react';

import type { LevelPickerIcon } from '../../shared/types/agent-preset';

export const LEVEL_PICKER_ICON_COMPONENTS: Record<LevelPickerIcon, Icon> = {
  gauge: Gauge,
  brain: Brain,
  lightbulb: Lightbulb,
  lightning: Lightning,
  sparkle: Sparkle,
  cpu: Cpu,
  rocket: Rocket,
  sliders: SlidersHorizontal,
  timer: Timer,
  atom: Atom,
  flask: Flask,
  fire: Fire,
};
