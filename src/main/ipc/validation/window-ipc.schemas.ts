import { z } from 'zod';

import { idSchema } from './primitives';

export const moveWorkspaceToWindowArgsSchema = z.tuple([
  idSchema,
  idSchema.nullable(),
  z.unknown().optional(),
]);

export const focusWorkspaceWindowArgsSchema = z.tuple([idSchema, idSchema.optional()]);

export const setPaneSurfaceWorkspacesArgsSchema = z.tuple([z.array(idSchema).max(10_000)]);

// Null while the window shows no single workspace, as on the overview.
export const setShownWorkspaceArgsSchema = z.tuple([idSchema.nullable()]);

// File names, shown in the dialog that asks before closing or quitting.
export const setUnsavedFilesArgsSchema = z.tuple([z.array(z.string().max(1024)).max(1000)]);

// The renderer only ever sends 6-digit lowercase hex (oklchTripletToHex output).
// Keep this tight rather than accepting arbitrary CSS color strings.
const titleBarColorSchema = z.string().regex(/^#[0-9a-f]{6}$/);

export const setTitleBarOverlayArgsSchema = z.tuple([
  z.object({
    color: titleBarColorSchema,
    symbolColor: titleBarColorSchema,
  }),
]);
