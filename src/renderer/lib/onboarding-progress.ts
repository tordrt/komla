/**
 * Marks onboarding as started-but-unfinished by remembering the project the
 * setup wizard created. The wizard only resumes when this marker exists, so
 * existing users who have projects but never ran onboarding are unaffected.
 */
const ONBOARDING_PROJECT_STORAGE_KEY = 'komla.onboardingProjectId';

export function readOnboardingProjectId(): string | null {
  try {
    return window.localStorage.getItem(ONBOARDING_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeOnboardingProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(ONBOARDING_PROJECT_STORAGE_KEY, projectId);
  } catch {
    // Storage unavailable — quitting mid-onboarding just won't resume it.
  }
}

export function clearOnboardingProjectId(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_PROJECT_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
