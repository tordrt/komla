---
status: accepted
---

# Manage agent-authored settings through confirmed aggregate HTTP resources

Komla will expose Actions and Workspace Setup as aggregate, versioned HTTP resources backed by its
domain modules rather than allowing agents to edit settings files directly. Callers submit desired
state without managing version tokens; Komla validates it, presents the semantic changes for native
user approval, rechecks its internal storage snapshot and invariants, and only then persists
atomically. Managed terminals receive a context-bound base URL that carries terminal identity;
unmanaged callers retain terminal headers and same-host cwd as fallbacks, while Global Actions
require no project context.

This contract was chosen over raw settings-file access and fine-grained CRUD routes because it keeps
storage formats private, supports sandboxed and remote callers, and concentrates validation,
approval, confirmation-time revalidation, and future MCP reuse behind one settings-management
module. Existing direct file editing and validation remain available for compatibility, but the
project-setup skill will use the confirmed HTTP resources and will not fall back to writing files.
Keeping identity in the injected URL was chosen over making agents coordinate an origin, terminal
header, and encoded cwd; legacy unscoped routes remain available for compatibility.
