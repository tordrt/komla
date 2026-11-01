import { z } from 'zod';

export const remoteControlDisconnectActiveArgsSchema = z.tuple([z.literal('direct')]);

export const remoteControlDirectStartArgsSchema = z.tuple([
  z.strictObject({ publicOrigin: z.string().trim().min(1).max(2048).optional() }).optional(),
]);

export const remoteControlHostAccessSetArgsSchema = z.tuple([
  z.strictObject({ hostId: z.string().min(1).max(128), enabled: z.boolean() }),
]);

const credentialIdSchema = z.string().min(1).max(1024);

export const pairedDevicesRenameArgsSchema = z.tuple([
  z.strictObject({ credentialId: credentialIdSchema, label: z.string().min(1).max(120) }),
]);

export const pairedDevicesRemoveArgsSchema = z.tuple([
  z.strictObject({ credentialId: credentialIdSchema }),
]);
