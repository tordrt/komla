const MAX_GIT_IDENTITY_LENGTH = 256;
// git silently drops these from names and emails, so the saved value would differ from what was typed.
const GIT_IDENTITY_DISALLOWED = /[<>\r\n\0]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/** Checks a git name and email typed by the user; returns an error message, or null when valid. */
export function validateGitIdentity(userName: string, userEmail: string): string | null {
  const name = userName.trim();
  const email = userEmail.trim();
  if (!name) return 'Enter your name for git commits';
  if (!email) return 'Enter your email for git commits';
  if (GIT_IDENTITY_DISALLOWED.test(name) || GIT_IDENTITY_DISALLOWED.test(email)) {
    return 'Name and email cannot contain <, > or line breaks';
  }
  if (name.length > MAX_GIT_IDENTITY_LENGTH || email.length > MAX_GIT_IDENTITY_LENGTH) {
    return `Name and email must be at most ${MAX_GIT_IDENTITY_LENGTH} characters`;
  }
  if (!EMAIL_SHAPE.test(email)) return 'Enter an email address like you@example.com';
  return null;
}
