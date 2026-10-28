import { z } from 'zod';

import { isBrowserUrl } from '../../../shared/lib/browser-tabs';

import { idSchema } from './primitives';

const browserUrlSchema = z.string().refine(isBrowserUrl, {
  message: 'URL must be an http(s) URL',
});

const coordinateSchema = z.number().min(-100_000).max(100_000);
const dimensionSchema = z.number().positive().max(100_000);

const devPreviewBoundsSchema = z
  .object({
    x: coordinateSchema,
    y: coordinateSchema,
    width: dimensionSchema,
    height: dimensionSchema,
  })
  .strip();

// Every page belongs to a workspace's browser tab: [workspaceId, tabId, ...].
export const devPreviewSyncArgsSchema = z.tuple([
  idSchema,
  idSchema,
  browserUrlSchema,
  devPreviewBoundsSchema,
]);
export const devPreviewHideArgsSchema = z.tuple([idSchema, idSchema]);
export const devPreviewCloseArgsSchema = z.tuple([idSchema, idSchema]);
export const devPreviewReloadArgsSchema = z.tuple([idSchema, idSchema, z.boolean()]);
export const devPreviewNavigateArgsSchema = z.tuple([
  idSchema,
  idSchema,
  z.enum(['back', 'forward']),
]);
export const devPreviewClearSiteDataArgsSchema = z.tuple([idSchema, idSchema]);
export const devPreviewCaptureArgsSchema = z.tuple([idSchema, idSchema]);
const detectPortsSchema = z.array(z.number().int().min(1).max(65535)).max(32);

export const devPreviewDetectServicesArgsSchema = z.tuple([
  idSchema,
  detectPortsSchema,
  detectPortsSchema,
  detectPortsSchema,
]);

export const linkPreviewGetArgsSchema = z.tuple([
  z
    .object({
      url: browserUrlSchema,
      workspaceId: idSchema,
      onSshHost: z.boolean(),
      pid: z.number().int().positive().optional(),
    })
    .strip(),
]);
export const linkPreviewImageArgsSchema = z.tuple([browserUrlSchema]);

const vncPortSchema = z.number().int().min(1).max(65535);

// [workspaceId, vncPort]: one of the workspace's virtual desktops.
export const virtualDesktopOpenInVncAppArgsSchema = z.tuple([idSchema, vncPortSchema]);
// [workspaceId, vncPorts, checkedAt]: the desktops found stopped, and when they were checked.
export const virtualDesktopForgetArgsSchema = z.tuple([
  idSchema,
  detectPortsSchema,
  z.number().int().nonnegative(),
]);
